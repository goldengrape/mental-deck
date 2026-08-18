import {
  CardInstance,
  DeckManifest,
  GameManifestV1,
  GamePackage,
  GamePackageDescriptor,
  InitializationPlan,
  LockedRoster,
  LockedSecurityDefinition,
  MechanicalActionSpec,
  ParameterSchema,
  PublicGameConfig,
  SetupStepSpec,
  ZoneDefinition,
  ZoneManifest,
  ZoneTemplate,
} from '../types/contracts';
import { hashCanonical } from '../crypto/cryptoProvider';

const TOKEN = /\{([a-zA-Z0-9_]+)\}/g;

function standard52(): CardInstance[] {
  const suits: Array<'♠' | '♥' | '♦' | '♣'> = ['♠', '♥', '♦', '♣'];
  const ranks = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
  return suits.flatMap(suit => ranks.map(rank => ({
    card_instance_id: `card_${rank}_${suit}`,
    symbol: `${rank}${suit}`,
    suit,
    rank,
    name: `${rank} of ${suit}`,
  })));
}

function assertManifest(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`Invalid mental-deck-game/v1 manifest: ${message}`);
}

function validateParameterSchema(schema: ParameterSchema): void {
  assertManifest(!!schema && typeof schema.type === 'string', 'parameter schema must declare type');
}

function validateTemplateTokens(value: string, action?: MechanicalActionSpec): void {
  for (const match of value.matchAll(TOKEN)) {
    const token = match[1];
    if (token === 'actor' || token === 'player') continue;
    assertManifest(!!action?.parameters?.[token], `zone token {${token}} requires a declared action parameter`);
    assertManifest(action!.parameters![token].type === 'ROSTER_PLAYER_ID', `zone token {${token}} must use ROSTER_PLAYER_ID`);
  }
}

export class GamePackageHost {
  private static allowlist = new Map<string, GamePackage>();

  static validateManifest(manifest: GameManifestV1): void {
    assertManifest(manifest.schema === 'mental-deck-game/v1', `unsupported schema ${String(manifest.schema)}`);
    assertManifest(!!manifest.game?.id && !!manifest.game?.version, 'game id/version required');
    assertManifest(Number.isInteger(manifest.players.min) && Number.isInteger(manifest.players.max), 'player bounds must be integers');
    assertManifest(manifest.players.min > 0 && manifest.players.max >= manifest.players.min, 'invalid player bounds');
    assertManifest(Array.isArray(manifest.zones) && manifest.zones.length > 0, 'at least one zone is required');

    const zoneIds = new Set<string>();
    for (const zone of manifest.zones) {
      assertManifest(!!zone.id, 'zone id required');
      assertManifest(!zoneIds.has(zone.id), `duplicate zone template ${zone.id}`);
      zoneIds.add(zone.id);
      validateTemplateTokens(zone.id);
    }

    const actionIds = new Set<string>();
    for (const action of manifest.mechanicalActions) {
      assertManifest(!!action.id && !actionIds.has(action.id), `duplicate/empty mechanical action ${action.id}`);
      actionIds.add(action.id);
      for (const schema of Object.values(action.parameters ?? {})) validateParameterSchema(schema);
      for (const step of action.steps) {
        if (step.from) validateTemplateTokens(step.from, action);
        if (step.to) validateTemplateTokens(step.to, action);
        const consumesCards = !['GRANT_CONTROL', 'REVOKE_CONTROL'].includes(step.op);
        if (step.from && consumesCards) assertManifest(!!step.source_access, `${action.id}: source_access required for card-consuming step`);
        if (step.source_access === 'BLIND_RANDOM') {
          assertManifest(step.op === 'RANDOM_MOVE', `${action.id}: BLIND_RANDOM only allowed with RANDOM_MOVE`);
          assertManifest(step.selection?.type === 'RANDOM', `${action.id}: BLIND_RANDOM requires RANDOM selection`);
          assertManifest((step.selection?.count ?? 0) > 0, `${action.id}: BLIND_RANDOM count must be fixed and positive`);
        }
        if (step.source_access === 'CONTROLLED' && step.selection?.type === 'RANDOM') {
          assertManifest(false, `${action.id}: use BLIND_RANDOM for random access to hidden source zones`);
        }
      }
    }

    const eventIds = new Set<string>();
    for (const event of manifest.gameEvents ?? []) {
      assertManifest(!!event.id && !eventIds.has(event.id), `duplicate/empty public event ${event.id}`);
      eventIds.add(event.id);
      for (const schema of Object.values(event.parameters ?? {})) validateParameterSchema(schema);
    }

    for (const setupStep of manifest.setup as Array<SetupStepSpec | { op: string; to: string }>) {
      const op = (setupStep as { op: string }).op;
      assertManifest(
        ['DEAL_ROUND_ROBIN', 'DEAL_ALL_ROUND_ROBIN', 'DEAL_COUNT', 'REMAINDER', 'MOVE_REMAINDER'].includes(op),
        `unsupported setup primitive ${op}`
      );
    }
  }

  static register(packageDef: GamePackage): void {
    this.validateManifest(packageDef.manifest);
    if (packageDef.descriptor.trust_status === 'untrusted') throw new Error(`Game package ${packageDef.manifest.game.id} is untrusted`);
    const key = `${packageDef.manifest.game.id}@${packageDef.manifest.game.version}`;
    this.allowlist.set(key, packageDef);
  }

  static resolve(gameId: string, version: string, packageReleaseHash: string): GamePackage {
    const key = `${gameId}@${version}`;
    const packageDef = this.allowlist.get(key);
    if (!packageDef) throw new Error(`Game package ${key} is not allowlisted`);
    if (packageDef.descriptor.package_release_hash !== packageReleaseHash) throw new Error(`Game package release hash mismatch for ${key}`);
    return packageDef;
  }

  static listAvailable(): GamePackage[] {
    return [...this.allowlist.values()];
  }

  static async buildSecurityDefinition(
    packageDef: GamePackage,
    roster: LockedRoster,
    publicConfig: PublicGameConfig
  ): Promise<LockedSecurityDefinition> {
    this.validateManifest(packageDef.manifest);
    const { manifest } = packageDef;
    if (roster.players.length < manifest.players.min || roster.players.length > manifest.players.max) {
      throw new Error(`Roster size ${roster.players.length} outside game bounds ${manifest.players.min}-${manifest.players.max}`);
    }

    const cards = 'builtin' in manifest.deck ? standard52() : manifest.deck.cards.map(card => ({ ...card }));
    const ids = new Set<string>();
    for (const card of cards) {
      if (ids.has(card.card_instance_id)) throw new Error(`Duplicate card_instance_id ${card.card_instance_id}`);
      ids.add(card.card_instance_id);
    }
    const deckManifest: DeckManifest = {
      deck_id: 'builtin' in manifest.deck ? 'standard_52' : (manifest.deck.deck_id ?? `${manifest.game.id}_deck`),
      version: 'builtin' in manifest.deck ? '1' : (manifest.deck.version ?? manifest.game.version),
      cards,
      deck_manifest_hash: await hashCanonical(cards),
    };

    const zones = this.expandZones(manifest.zones, roster);
    const zoneManifest: ZoneManifest = { zones, zone_manifest_hash: await hashCanonical(zones) };
    const setupPlan = await this.buildSetupPlan(manifest.setup, roster, zones, cards.length);
    const publicConfigRecord: Record<string, unknown> = {
      min_players: publicConfig.min_players,
      max_players: publicConfig.max_players,
      custom_options: publicConfig.custom_options ?? {},
    };
    const securityMaterial = {
      game_id: manifest.game.id,
      game_version: manifest.game.version,
      roster_hash: roster.roster_hash,
      public_config: publicConfigRecord,
      deck_manifest: deckManifest,
      zone_manifest: zoneManifest,
      setup_plan: setupPlan,
      mechanical_policy: manifest.mechanicalActions,
      public_game_event_schemas: manifest.gameEvents ?? [],
    };
    return {
      ...securityMaterial,
      security_definition_hash: await hashCanonical(securityMaterial),
      package_release_hash: packageDef.descriptor.package_release_hash,
    };
  }

  static expandZones(templates: ZoneTemplate[], roster: LockedRoster): ZoneDefinition[] {
    const result: ZoneDefinition[] = [];
    for (const template of templates) {
      if (template.id.includes('{player}') || template.owner === '{player}') {
        for (const player of roster.players) result.push(this.expandZone(template, player.player_id, player.display_name));
      } else {
        result.push(this.expandZone(template));
      }
    }
    const ids = new Set<string>();
    for (const zone of result) {
      if (ids.has(zone.zone_id)) throw new Error(`Expanded zone id collision ${zone.zone_id}`);
      ids.add(zone.zone_id);
    }
    return result;
  }

  private static expandZone(template: ZoneTemplate, playerId?: string, displayName?: string): ZoneDefinition {
    const replace = (value: string) => playerId ? value.replaceAll('{player}', playerId) : value;
    const owner = template.owner === 'shared' ? null : template.owner === '{player}' ? playerId ?? null : replace(template.owner);
    const zoneId = replace(template.id);
    return {
      zone_id: zoneId,
      name: template.name ? replace(template.name).replaceAll('{player_name}', displayName ?? playerId ?? '') : zoneId,
      owner_player_id: owner,
      ordering: template.ordering,
      default_visibility: template.visibility,
      controller_policy: template.controller_policy ?? (owner ? 'OWNER' : 'SHARED'),
    };
  }

  private static async buildSetupPlan(
    setup: SetupStepSpec[],
    roster: LockedRoster,
    zones: ZoneDefinition[],
    deckSize: number
  ): Promise<InitializationPlan> {
    const zoneIds = new Set(zones.map(z => z.zone_id));
    const steps: InitializationPlan['steps'] = [];
    let allocated = 0;
    let sequence = 0;
    for (const typedSpec of setup) {
      const spec = typedSpec as unknown as Record<string, unknown>;
      const op = String(spec.op);
      const to = typeof spec.to === 'string' ? spec.to : '';

      if (op === 'DEAL_ALL_ROUND_ROBIN') {
        if (!to.includes('{player}')) throw new Error('DEAL_ALL_ROUND_ROBIN destination must include {player}');
        let playerIndex = 0;
        while (allocated < deckSize) {
          const player = roster.players[playerIndex % roster.players.length];
          const zoneId = to.replaceAll('{player}', player.player_id);
          if (!zoneIds.has(zoneId)) throw new Error(`Setup destination ${zoneId} does not exist`);
          steps.push({ step_id: `setup_${++sequence}`, source_pool: 'privacy_pool', destination_zone_id: zoneId, count: 1, selector: 'TOP' });
          allocated++;
          playerIndex++;
        }
      } else if (op === 'DEAL_ROUND_ROBIN') {
        const countPerPlayer = Number(spec.count_per_player ?? 0);
        if (!Number.isInteger(countPerPlayer) || countPerPlayer < 0) throw new Error('DEAL_ROUND_ROBIN count_per_player must be a non-negative integer');
        for (let round = 0; round < countPerPlayer; round++) {
          for (const player of roster.players) {
            const zoneId = to.replaceAll('{player}', player.player_id);
            if (!zoneIds.has(zoneId)) throw new Error(`Setup destination ${zoneId} does not exist`);
            steps.push({ step_id: `setup_${++sequence}`, source_pool: 'privacy_pool', destination_zone_id: zoneId, count: 1, selector: 'TOP' });
            allocated++;
          }
        }
      } else if (op === 'DEAL_COUNT') {
        if (typeof spec.player_param !== 'string') throw new Error('DEAL_COUNT requires player_param in v0.10 MVP');
        throw new Error('DEAL_COUNT with runtime player parameter is not supported during locked setup; use DEAL_ROUND_ROBIN');
      } else if (op === 'REMAINDER' || op === 'MOVE_REMAINDER') {
        if (!zoneIds.has(to)) throw new Error(`Setup remainder destination ${to} does not exist`);
        const remaining = deckSize - allocated;
        if (remaining < 0) throw new Error('Setup allocates more cards than deck contains');
        if (remaining > 0) {
          steps.push({ step_id: `setup_${++sequence}`, source_pool: 'privacy_pool', destination_zone_id: to, count: remaining, selector: 'TOP' });
          allocated += remaining;
        }
      }
    }
    if (allocated !== deckSize) throw new Error(`Setup must allocate every card exactly once; allocated ${allocated}/${deckSize}`);
    return { steps, plan_hash: await hashCanonical(steps) };
  }
}

export async function makePackageDescriptor(
  manifest: GameManifestV1,
  trustStatus: GamePackageDescriptor['trust_status'] = 'product_shipped'
): Promise<GamePackageDescriptor> {
  const manifestHash = await hashCanonical(manifest);
  return {
    package_id: manifest.game.id,
    package_version: manifest.game.version,
    package_release_hash: await hashCanonical({ manifest_hash: manifestHash, modules: manifest.modules ?? {} }),
    trust_status: trustStatus,
    name: manifest.game.name,
    description: `${manifest.game.name} mental-deck-game/v1 package`,
  };
}
