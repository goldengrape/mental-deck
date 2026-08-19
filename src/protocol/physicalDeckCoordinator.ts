import {
  CommittedGameState,
  CoreOperation,
  GamePackage,
  LockedRoster,
  LockedSecurityDefinition,
  OperationPlan,
  PlayerIdentity,
  PublicGameConfig,
  PublicGameEventSpec,
  ResolvedSelection,
  SignedMechanicalIntent,
  SignedPublicGameEvent,
  StateTransitionRecord,
  ZoneDefinition,
} from '../types/contracts';
import { hashCanonical, MentalDeckCrypto } from '../crypto/cryptoProvider';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { PrivacyPoolBootstrap } from '../core/privacyPool';
import { AtomicTransitionKernel } from '../core/atomicKernel';
import { ControllerEngine } from '../core/controllerEngine';
import { MechanicalPolicyEngine, ResolvedMechanicalStep } from '../core/mechanicalPolicy';
import { DeterministicSelectionResolver } from '../core/selection';
import { StateLedger } from '../core/stateLedger';
import { GamePackageHost } from '../plugins/gamePackageHost';

export type PhysicalDeckPhase = 'PACKAGE_LOCKED' | 'PLAYERS_JOINING' | 'ROSTER_LOCKED' | 'DEFINITION_LOCKED' | 'READY';

function hasCardRef(value: unknown): boolean {
  if (!value) return false;
  if (Array.isArray(value)) return value.some(hasCardRef);
  if (typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  if (typeof candidate.ref_id === 'string' && Number.isInteger(candidate.epoch)) return true;
  return Object.values(candidate).some(hasCardRef);
}

export class PhysicalDeckCoordinator {
  public phase: PhysicalDeckPhase = 'PACKAGE_LOCKED';
  public readonly draftPlayers: PlayerIdentity[] = [];
  public lockedRoster?: LockedRoster;
  public lockedDefinition?: LockedSecurityDefinition;
  public stateLedger?: StateLedger;
  public readonly receiptStore = new Map<string, Awaited<ReturnType<typeof MultipartyRandomIndexProtocol.finalizeSelection>>>();
  public readonly consumedReceipts = new Set<string>();
  public zoneDefinitions: Record<string, ZoneDefinition> = {};

  constructor(
    public readonly gameId: string,
    public readonly gamePackage: GamePackage,
    public readonly publicConfig: PublicGameConfig = {
      min_players: gamePackage.manifest.players.min,
      max_players: gamePackage.manifest.players.max,
    }
  ) {
    GamePackageHost.validateManifest(gamePackage.manifest);
    if (gamePackage.manifest.game.id !== gameId) throw new Error('Coordinator gameId must match Game Package manifest id');
    if (gamePackage.descriptor.trust_status === 'untrusted') throw new Error('Cannot run an untrusted Game Package');
  }

  async registerPlayer(player: PlayerIdentity): Promise<void> {
    if (this.phase !== 'PACKAGE_LOCKED' && this.phase !== 'PLAYERS_JOINING') throw new Error(`Cannot register player in phase ${this.phase}`);
    if (this.draftPlayers.some(p => p.player_id === player.player_id)) throw new Error(`Duplicate player ${player.player_id}`);
    if (this.draftPlayers.length >= this.gamePackage.manifest.players.max) throw new Error('Game roster is full');
    if (!player.signing_public_key || !player.encryption_public_key || !player.pok_proof) {
      throw new Error('Player registration requires signing/encryption keys and ownership proof');
    }
    if (!(await MentalDeckCrypto.verifyPoK(player.player_id, player.encryption_public_key, player.pok_proof))) {
      throw new Error(`Encryption-key ownership proof failed for ${player.player_id}`);
    }
    this.draftPlayers.push({ ...player });
    this.phase = 'PLAYERS_JOINING';
  }

  async lockRoster(): Promise<LockedRoster> {
    const bounds = this.gamePackage.manifest.players;
    if (this.draftPlayers.length < bounds.min || this.draftPlayers.length > bounds.max) {
      throw new Error(`Roster size ${this.draftPlayers.length} outside game bounds ${bounds.min}-${bounds.max}`);
    }
    const players = this.draftPlayers.map(player => ({ ...player }));
    this.lockedRoster = { players, roster_hash: await hashCanonical(players), locked_at: Date.now() };
    this.phase = 'ROSTER_LOCKED';
    return this.lockedRoster;
  }

  async lockSecurityDefinition(): Promise<LockedSecurityDefinition> {
    if (!this.lockedRoster) throw new Error('Roster must be locked first');
    this.lockedDefinition = await GamePackageHost.buildSecurityDefinition(this.gamePackage, this.lockedRoster, this.publicConfig);
    this.zoneDefinitions = Object.fromEntries(this.lockedDefinition.zone_manifest.zones.map(zone => [zone.zone_id, zone]));
    this.phase = 'DEFINITION_LOCKED';
    return this.lockedDefinition;
  }

  /**
   * Provider boundary: accepts only an already shuffled opaque CardRef vector.
   * The real multi-client crypto ceremony may be swapped in without changing package/runtime logic.
   */
  async initializeOpaqueState(shuffledRefs: Array<{ ref_id: string; epoch: number }>): Promise<CommittedGameState> {
    if (!this.lockedDefinition) throw new Error('Security definition must be locked first');
    if (shuffledRefs.length !== this.lockedDefinition.deck_manifest.cards.length) throw new Error('Opaque deck size does not match locked deck manifest');
    const uniqueRefs = new Set(shuffledRefs.map(ref => `${ref.ref_id}@${ref.epoch}`));
    if (uniqueRefs.size !== shuffledRefs.length) throw new Error('Opaque shuffled deck contains duplicate CardRefs');
    const zoneStates = await PrivacyPoolBootstrap.executeAllocationPlan(
      shuffledRefs,
      this.lockedDefinition.zone_manifest,
      this.lockedDefinition.setup_plan
    );
    const securityState = {
      state_version: 0,
      prev_state_hash: 'GENESIS_0000000000000000000000000000000000000000000000000000000000000000',
      zone_states: zoneStates,
      groups: {},
      public_bindings: {},
      disclosure_grants: {},
      controller_grants: {},
      last_transition_commitment: 'GENESIS',
      active_workflow_id: null,
    };
    const state: CommittedGameState = {
      ...securityState,
      state_hash: await hashCanonical(securityState),
      grants: {},
      game_state_extension: {},
      game_state_extension_hash: await hashCanonical({}),
      last_action_summary: 'Physical Deck state initialized from opaque shuffled refs',
    };
    this.stateLedger = new StateLedger(state);
    this.phase = 'READY';
    return state;
  }

  async submitMechanicalIntent(intent: SignedMechanicalIntent): Promise<StateTransitionRecord> {
    const { state, definition, roster } = await this.verifyMechanicalIntent(intent);
    const rosterIds = roster.players.map(candidate => candidate.player_id);
    const resolved = MechanicalPolicyEngine.resolve(definition, intent, rosterIds);
    const operations: CoreOperation[] = [];
    const evidenceRefs: string[] = [];
    const pendingGrantSteps: ResolvedMechanicalStep[] = [];

    for (const step of resolved.steps) {
      if (step.op === 'GRANT_CONTROL' || step.op === 'REVOKE_CONTROL') {
        pendingGrantSteps.push(step);
        continue;
      }
      if (!step.source_zone_id) throw new Error(`${intent.action_id}: card operation ${step.op} requires a source zone`);
      const sourceDef = this.zoneDefinitions[step.source_zone_id];
      const sourceState = state.zone_states[step.source_zone_id];
      if (!sourceDef || !sourceState) throw new Error(`Unknown source zone ${step.source_zone_id}`);

      let selected: ResolvedSelection;
      if (step.source_access === 'BLIND_RANDOM') {
        if (sourceDef.ordering !== 'UNORDERED' || sourceDef.default_visibility === 'PUBLIC') {
          throw new Error('BLIND_RANDOM requires a hidden UNORDERED source zone');
        }
        if (step.selection?.type !== 'RANDOM' || (step.selection.count ?? 0) !== 1) {
          throw new Error('Current v0.10 RandomIndex provider supports fixed RANDOM(1) only');
        }
        const randomContext = {
          workflow_id: intent.intent_id,
          parent_state_hash: state.state_hash,
          source_zone_id: sourceDef.zone_id,
          source_ref_set_commitment: sourceState.commitment_hash,
          card_count: sourceState.card_refs.length,
          participant_ids: rosterIds,
          round: 1,
        };
        const commitments: Record<string, string> = {};
        const nonces: Record<string, string> = {};
        // Simulation-only contribution transport. Production clients submit these independently.
        for (const participantId of rosterIds) {
          const contribution = await MultipartyRandomIndexProtocol.generateCommitment(participantId, randomContext);
          commitments[participantId] = contribution.commitment;
          nonces[participantId] = contribution.nonce;
        }
        const finalized = await MultipartyRandomIndexProtocol.finalizeSelectionWithProvenance(
          randomContext,
          commitments,
          nonces,
          sourceState.card_refs
        );
        this.receiptStore.set(finalized.receipt.receipt_hash, finalized.receipt);
        evidenceRefs.push(finalized.receipt.receipt_hash);
        selected = finalized.resolved_selection;
      } else {
        if (step.source_access !== 'CONTROLLED') throw new Error(`${intent.action_id}: source_access must be CONTROLLED or BLIND_RANDOM`);
        if (!ControllerEngine.isController(state, sourceDef, intent.actor_id, intent.action_id, rosterIds)) {
          throw new Error(`Actor ${intent.actor_id} is not a controller of ${sourceDef.zone_id} for action ${intent.action_id}`);
        }
        if (!step.selection || step.selection.type === 'RANDOM') throw new Error('CONTROLLED action requires a deterministic selection');
        selected = await DeterministicSelectionResolver.resolveSelection(
          sourceState,
          sourceDef,
          step.selection,
          intent.actor_id,
          intent.intent_id,
          state.state_hash,
          true
        );
      }

      if (step.op === 'REVEAL_PUBLIC' || step.op === 'REVEAL_OWNER') {
        operations.push({
          op_type: step.op === 'REVEAL_PUBLIC' ? 'REVEAL_PUBLIC' : 'REVEAL_TO',
          card_refs: selected.selected_card_refs,
          viewers: step.op === 'REVEAL_PUBLIC' ? ['PUBLIC'] : [sourceDef.owner_player_id ?? intent.actor_id],
        });
        continue;
      }

      if (!step.destination_zone_id) throw new Error(`${intent.action_id}: ${step.op} requires a destination zone`);
      const destinationDef = this.zoneDefinitions[step.destination_zone_id];
      if (!destinationDef) throw new Error(`Unknown destination zone ${step.destination_zone_id}`);
      operations.push({
        op_type: 'MOVE',
        source_zone_id: sourceDef.zone_id,
        destination_zone_id: destinationDef.zone_id,
        resolved_selection: selected,
        placement: 'TOP',
      });

      const revealMode = step.reveal ?? (step.op === 'MOVE_REVEAL_PUBLIC' ? 'PUBLIC' : step.op === 'MOVE_REVEAL_OWNER' ? 'OWNER' : 'NONE');
      if (revealMode === 'PUBLIC') {
        operations.push({ op_type: 'REVEAL_PUBLIC', card_refs: selected.selected_card_refs, viewers: ['PUBLIC'] });
      } else if (revealMode === 'OWNER') {
        const viewer = destinationDef.owner_player_id ?? intent.actor_id;
        operations.push({ op_type: 'REVEAL_TO', card_refs: selected.selected_card_refs, viewers: [viewer] });
      }
    }

    const plan: OperationPlan = {
      operations,
      is_atomic: true,
      plan_hash: await hashCanonical({ action_id: intent.action_id, operations }),
    };
    const candidate = await AtomicTransitionKernel.simulatePlan(
      state,
      this.zoneDefinitions,
      plan,
      definition.deck_manifest.cards.length,
      intent.actor_id,
      this.receiptStore,
      this.consumedReceipts,
      intent.action_id,
      rosterIds
    );

    const controllerGrants = candidate.simulated_controller_grants ?? { ...(state.controller_grants ?? {}) };
    const declaredActionIds = definition.mechanical_policy.map(action => action.id);
    for (const step of pendingGrantSteps) {
      const zoneId = step.source_zone_id;
      if (!zoneId) throw new Error(`${step.op} requires a source Zone template`);
      const zone = this.zoneDefinitions[zoneId];
      if (!zone) throw new Error(`Unknown controller-grant zone ${zoneId}`);
      if (step.op === 'GRANT_CONTROL') {
        const controller = intent.parameters.controller_player_id;
        if (typeof controller !== 'string') throw new Error('GRANT_CONTROL requires controller_player_id');
        const grant = await ControllerEngine.createOwnerGrant(
          state,
          zone,
          intent.actor_id,
          controller,
          step.action_scope ?? [],
          intent.intent_id,
          declaredActionIds,
          rosterIds
        );
        controllerGrants[grant.grant_id] = grant;
      } else {
        const grantId = intent.parameters.grant_id;
        if (typeof grantId !== 'string') throw new Error('REVOKE_CONTROL requires grant_id');
        controllerGrants[grantId] = ControllerEngine.revokeGrant({ ...state, controller_grants: controllerGrants }, grantId, intent.actor_id);
      }
    }
    candidate.simulated_controller_grants = controllerGrants;

    const publicParameters: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(intent.parameters)) {
      if (!hasCardRef(value)) publicParameters[key] = value;
    }
    const publicPayload = { action_id: intent.action_id, parameters: publicParameters };
    const publicPayloadHash = await hashCanonical(publicPayload);
    const privateInputCommitment = hasCardRef(intent.parameters) ? await hashCanonical(intent.parameters) : undefined;
    const transitionCommitment = await hashCanonical({
      transition_kind: 'MECHANICAL',
      actor_id: intent.actor_id,
      type_id: intent.action_id,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
      public_payload_hash: publicPayloadHash,
      private_input_commitment: privateInputCommitment ?? '',
      evidence_refs: evidenceRefs,
      candidate_hash: candidate.candidate_hash,
    });
    const next = await this.buildNextState(state, candidate, transitionCommitment, `Mechanical action ${intent.action_id}`);
    const record: StateTransitionRecord = {
      state_version: next.state_version,
      transition_kind: 'MECHANICAL',
      actor_id: intent.actor_id,
      type_id: intent.action_id,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
      public_payload: publicPayload,
      public_payload_hash: publicPayloadHash,
      private_input_commitment: privateInputCommitment,
      evidence_refs: evidenceRefs,
      transition_commitment: transitionCommitment,
      resulting_state_hash: next.state_hash,
    };
    await this.stateLedger!.appendTransition(next, record);
    for (const evidenceRef of evidenceRefs) this.consumedReceipts.add(evidenceRef);
    return record;
  }

  async submitPublicGameEvent(event: SignedPublicGameEvent): Promise<StateTransitionRecord> {
    if (!this.stateLedger || !this.lockedDefinition || !this.lockedRoster) throw new Error('Coordinator is not READY');
    const state = this.stateLedger.current;
    if (event.game_id !== this.gameId || event.security_definition_hash !== this.lockedDefinition.security_definition_hash) {
      throw new Error('Public game event game/definition mismatch');
    }
    if (event.base_state_hash !== state.state_hash || event.base_state_version !== state.state_version) {
      throw new Error('Public game event is stale or bound to the wrong state');
    }
    const player = this.lockedRoster.players.find(candidate => candidate.player_id === event.actor_id);
    if (!player) throw new Error(`Unknown public-event actor ${event.actor_id}`);
    const schema = this.lockedDefinition.public_game_event_schemas.find(candidate => candidate.id === event.event_type);
    if (!schema) throw new Error(`Public game event ${event.event_type} is not declared by manifest`);
    this.validatePublicEventParameters(schema, event.parameters, this.lockedRoster.players.map(candidate => candidate.player_id));
    const { signature, ...unsigned } = event;
    if (!(await MentalDeckCrypto.verifySemanticIntent(player.signing_public_key, signature, unsigned))) {
      throw new Error(`Invalid public game event signature for ${event.actor_id}`);
    }

    const publicPayload = { event_type: event.event_type, parameters: event.parameters };
    const publicPayloadHash = await hashCanonical(publicPayload);
    const transitionCommitment = await hashCanonical({
      transition_kind: 'PUBLIC_GAME_EVENT',
      actor_id: event.actor_id,
      type_id: event.event_type,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
      public_payload_hash: publicPayloadHash,
      evidence_refs: [],
    });
    const candidate = await AtomicTransitionKernel.simulatePlan(
      state,
      this.zoneDefinitions,
      { operations: [], is_atomic: true, plan_hash: await hashCanonical(['PUBLIC_GAME_EVENT', event.event_id]) },
      this.lockedDefinition.deck_manifest.cards.length,
      event.actor_id
    );
    const next = await this.buildNextState(state, candidate, transitionCommitment, `Public game event ${event.event_type}`);
    const record: StateTransitionRecord = {
      state_version: next.state_version,
      transition_kind: 'PUBLIC_GAME_EVENT',
      actor_id: event.actor_id,
      type_id: event.event_type,
      base_state_hash: state.state_hash,
      base_state_version: state.state_version,
      public_payload: publicPayload,
      public_payload_hash: publicPayloadHash,
      evidence_refs: [],
      transition_commitment: transitionCommitment,
      resulting_state_hash: next.state_hash,
    };
    await this.stateLedger.appendTransition(next, record);
    return record;
  }

  private async verifyMechanicalIntent(intent: SignedMechanicalIntent): Promise<{
    state: CommittedGameState;
    definition: LockedSecurityDefinition;
    roster: LockedRoster;
    player: PlayerIdentity;
  }> {
    if (!this.stateLedger || !this.lockedDefinition || !this.lockedRoster || this.phase !== 'READY') throw new Error('Coordinator is not READY');
    const state = this.stateLedger.current;
    if (intent.game_id !== this.gameId || intent.security_definition_hash !== this.lockedDefinition.security_definition_hash) {
      throw new Error('Mechanical intent game/definition mismatch');
    }
    if (intent.base_state_hash !== state.state_hash || intent.base_state_version !== state.state_version) {
      throw new Error('Mechanical intent is stale or bound to the wrong state');
    }
    const player = this.lockedRoster.players.find(candidate => candidate.player_id === intent.actor_id);
    if (!player) throw new Error(`Unknown mechanical-intent actor ${intent.actor_id}`);
    const { signature, ...unsigned } = intent;
    if (!(await MentalDeckCrypto.verifySemanticIntent(player.signing_public_key, signature, unsigned))) {
      throw new Error(`Invalid mechanical intent signature for ${intent.actor_id}`);
    }
    return { state, definition: this.lockedDefinition, roster: this.lockedRoster, player };
  }

  private async buildNextState(
    baseState: CommittedGameState,
    candidate: Awaited<ReturnType<typeof AtomicTransitionKernel.simulatePlan>>,
    transitionCommitment: string,
    summary: string
  ): Promise<CommittedGameState> {
    const securityState = {
      state_version: baseState.state_version + 1,
      prev_state_hash: baseState.state_hash,
      zone_states: candidate.simulated_zone_states,
      groups: candidate.simulated_groups,
      public_bindings: candidate.simulated_public_bindings,
      disclosure_grants: candidate.simulated_grants,
      controller_grants: candidate.simulated_controller_grants ?? baseState.controller_grants ?? {},
      last_transition_commitment: transitionCommitment,
      active_workflow_id: null,
    };
    return {
      ...securityState,
      state_hash: await hashCanonical(securityState),
      grants: candidate.simulated_grants,
      // Non-TCB compatibility fields are deliberately excluded from the state hash above.
      game_state_extension: baseState.game_state_extension,
      game_state_extension_hash: baseState.game_state_extension_hash,
      last_action_summary: summary,
    };
  }

  private validatePublicEventParameters(schema: PublicGameEventSpec, params: Record<string, unknown>, rosterIds: string[]): void {
    const declared = schema.parameters ?? {};
    for (const [name, paramSchema] of Object.entries(declared)) {
      if (!(name in params)) throw new Error(`Public event ${schema.id} missing parameter ${name}`);
      const value = params[name];
      if (paramSchema.type === 'ROSTER_PLAYER_ID' && (typeof value !== 'string' || !rosterIds.includes(value))) {
        throw new Error(`Public event parameter ${name} must identify locked roster player`);
      }
      if (paramSchema.type === 'STRING') {
        if (typeof value !== 'string') throw new Error(`Public event parameter ${name} must be string`);
        if (paramSchema.enum && !paramSchema.enum.includes(value)) throw new Error(`Public event parameter ${name} not in enum`);
      }
      if (paramSchema.type === 'INTEGER') {
        if (!Number.isInteger(value)) throw new Error(`Public event parameter ${name} must be integer`);
        if (paramSchema.min !== undefined && (value as number) < paramSchema.min) throw new Error(`Public event parameter ${name} below minimum`);
        if (paramSchema.max !== undefined && (value as number) > paramSchema.max) throw new Error(`Public event parameter ${name} above maximum`);
      }
      if (paramSchema.type === 'BOOLEAN' && typeof value !== 'boolean') throw new Error(`Public event parameter ${name} must be boolean`);
      if (paramSchema.type === 'CARD_REF' || paramSchema.type === 'CARD_REF_LIST') {
        throw new Error('Public game events may not carry private CardRef parameters in v0.10 MVP');
      }
    }
    for (const key of Object.keys(params)) if (!(key in declared)) throw new Error(`Public event ${schema.id} received undeclared parameter ${key}`);
  }
}
