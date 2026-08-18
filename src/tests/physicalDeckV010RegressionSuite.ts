import { ControllerEngine } from '../core/controllerEngine';
import { hashCanonical, MentalDeckCrypto } from '../crypto/cryptoProvider';
import { GamePackageHost, makePackageDescriptor } from '../plugins/gamePackageHost';
import { buildOldMaidGamePackage, OLD_MAID_GAME_MANIFEST } from '../plugins/oldMaid/package';
import { buildUnoGamePackage } from '../plugins/uno/package';
import { PhysicalDeckCoordinator } from '../protocol/physicalDeckCoordinator';
import type {
  CardRef,
  CommittedGameState,
  GameManifestV1,
  GamePackage,
  PlayerIdentity,
  SignedMechanicalIntent,
  SignedPublicGameEvent,
  ZoneDefinition,
} from '../types/contracts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(fn: () => Promise<unknown>, pattern: RegExp, label: string): Promise<void> {
  try {
    await fn();
    throw new Error(`${label}: expected rejection, operation succeeded`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('expected rejection, operation succeeded')) throw error;
    assert(pattern.test(message), `${label}: wrong rejection: ${message}`);
  }
}

interface TestPlayer { identity: PlayerIdentity; signingPrivateKey: string }

async function makePlayers(gameId: string, ids: string[]): Promise<TestPlayer[]> {
  return Promise.all(ids.map(async id => {
    const keys = await MentalDeckCrypto.generatePlayerKeys(id, gameId);
    return {
      identity: {
        player_id: id,
        display_name: id.toUpperCase(),
        is_ai: id.includes('ai'),
        signing_public_key: keys.signing.publicKey,
        encryption_public_key: keys.encryption.publicKey,
        pok_proof: keys.encryption.pokProof,
      },
      signingPrivateKey: keys.signing.privateKey,
    };
  }));
}

function opaqueRefs(count: number): CardRef[] {
  return Array.from({ length: count }, (_, index) => ({ ref_id: `opaque_${index.toString().padStart(3, '0')}`, epoch: 1 }));
}

async function ready(packageDef: GamePackage, ids = ['alice', 'bob', 'charlie_ai']) {
  const coordinator = new PhysicalDeckCoordinator(packageDef.manifest.game.id, packageDef);
  const players = await makePlayers(packageDef.manifest.game.id, ids);
  for (const player of players) await coordinator.registerPlayer(player.identity);
  await coordinator.lockRoster();
  const definition = await coordinator.lockSecurityDefinition();
  await coordinator.initializeOpaqueState(opaqueRefs(definition.deck_manifest.cards.length));
  return { coordinator, players };
}

async function signMechanical(
  coordinator: PhysicalDeckCoordinator,
  player: TestPlayer,
  actionId: string,
  parameters: Record<string, unknown>
): Promise<SignedMechanicalIntent> {
  const state = coordinator.stateLedger!.current;
  const unsigned = {
    intent_id: `intent_${actionId}_${state.state_version}_${player.identity.player_id}`,
    actor_id: player.identity.player_id,
    game_id: coordinator.gameId,
    security_definition_hash: coordinator.lockedDefinition!.security_definition_hash,
    action_id: actionId,
    parameters,
    base_state_hash: state.state_hash,
    base_state_version: state.state_version,
  };
  return { ...unsigned, signature: await MentalDeckCrypto.signSemanticIntent(player.signingPrivateKey, unsigned) };
}

async function signEvent(
  coordinator: PhysicalDeckCoordinator,
  player: TestPlayer,
  eventType: string,
  parameters: Record<string, unknown>,
  suffix = ''
): Promise<SignedPublicGameEvent> {
  const state = coordinator.stateLedger!.current;
  const unsigned = {
    event_id: `event_${eventType}_${state.state_version}_${player.identity.player_id}${suffix}`,
    actor_id: player.identity.player_id,
    game_id: coordinator.gameId,
    security_definition_hash: coordinator.lockedDefinition!.security_definition_hash,
    event_type: eventType,
    parameters,
    base_state_hash: state.state_hash,
    base_state_version: state.state_version,
  };
  return { ...unsigned, signature: await MentalDeckCrypto.signSemanticIntent(player.signingPrivateKey, unsigned) };
}

async function blindRandomDoesNotLeakHandle(): Promise<void> {
  const { coordinator, players } = await ready(await buildOldMaidGamePackage());
  const before = coordinator.stateLedger!.current;
  const aliceBefore = before.zone_states['hand:alice'].card_refs.length;
  const bobBefore = before.zone_states['hand:bob'].card_refs.map(ref => ({ ...ref }));
  const intent = await signMechanical(coordinator, players[0], 'draw_random_from_player', { target_player_id: 'bob' });
  const record = await coordinator.submitMechanicalIntent(intent);
  const after = coordinator.stateLedger!.current;
  assert(after.zone_states['hand:alice'].card_refs.length === aliceBefore + 1, 'actor did not receive exactly one card');
  assert(after.zone_states['hand:bob'].card_refs.length === bobBefore.length - 1, 'target did not lose exactly one card');
  const remaining = new Set(after.zone_states['hand:bob'].card_refs.map(ref => ref.ref_id));
  const moved = bobBefore.find(ref => !remaining.has(ref.ref_id));
  assert(!!moved, 'internal state could not identify moved ref');
  assert(!JSON.stringify(record.public_payload).includes(moved.ref_id), 'public transition leaked randomly selected hidden CardRef');
  assert(record.evidence_refs.length === 1, 'blind random transition missing receipt evidence');
}

async function gameRuleViolationCanRemainMechanicallyValid(): Promise<void> {
  const { coordinator, players } = await ready(await buildOldMaidGamePackage());
  const hand = coordinator.stateLedger!.current.zone_states['hand:alice'].card_refs;
  const intent = await signMechanical(coordinator, players[0], 'discard_claim', { cards: [hand[0], hand[1]] });
  await coordinator.submitMechanicalIntent(intent);
  const state = coordinator.stateLedger!.current;
  assert(state.zone_states.discarded_pairs.card_refs.length === 2, 'pair claim did not move two real controlled cards');
  assert(Object.keys(state.disclosure_grants ?? {}).length === 1, 'public pair claim did not stage disclosure');
}

async function foreignHandleRejected(): Promise<void> {
  const { coordinator, players } = await ready(await buildOldMaidGamePackage());
  const foreign = coordinator.stateLedger!.current.zone_states['hand:bob'].card_refs;
  const intent = await signMechanical(coordinator, players[0], 'discard_claim', { cards: [foreign[0], foreign[1]] });
  await expectReject(() => coordinator.submitMechanicalIntent(intent), /does not exactly exist|not authorized/, 'foreign BY_HANDLE');
}

async function publicEventsShareGlobalOrder(): Promise<void> {
  const { coordinator, players } = await ready(await buildOldMaidGamePackage());
  const first = await signEvent(coordinator, players[0], 'end_turn', {});
  const stale = await signEvent(coordinator, players[0], 'end_turn', {}, '_stale');
  const record = await coordinator.submitPublicGameEvent(first);
  assert(record.state_version === 1, 'public event did not advance state version');
  assert(coordinator.stateLedger!.getTransitionStream().length === 1, 'public event missing from unified transition stream');
  await expectReject(() => coordinator.submitPublicGameEvent(stale), /stale|wrong state/, 'stale public event');
}

async function ruleModuleDoesNotChangeSecurityHash(): Promise<void> {
  const basePackage = await buildOldMaidGamePackage();
  const changedManifest: GameManifestV1 = {
    ...OLD_MAID_GAME_MANIFEST,
    modules: { ...(OLD_MAID_GAME_MANIFEST.modules ?? {}), rules: './different-rule-advisor.ts' },
  };
  const changedPackage: GamePackage = { descriptor: await makePackageDescriptor(changedManifest), manifest: changedManifest };
  const players = await makePlayers(basePackage.manifest.game.id, ['alice', 'bob', 'charlie_ai']);
  const rosterPlayers = players.map(player => player.identity);
  const roster = { players: rosterPlayers, roster_hash: await hashCanonical(rosterPlayers), locked_at: 0 };
  const config = { min_players: 2, max_players: 6 };
  const a = await GamePackageHost.buildSecurityDefinition(basePackage, roster, config);
  const b = await GamePackageHost.buildSecurityDefinition(changedPackage, roster, config);
  assert(a.security_definition_hash === b.security_definition_hash, 'Rule Advisor path changed security_definition_hash');
  assert(a.package_release_hash !== b.package_release_hash, 'Rule Advisor path should change package_release_hash');
}

async function controllerGrantIsScoped(): Promise<void> {
  const zone: ZoneDefinition = {
    zone_id: 'dummy_hand',
    name: 'Dummy Hand',
    owner_player_id: 'south',
    ordering: 'UNORDERED',
    default_visibility: 'OWNER_ONLY',
    controller_policy: 'DELEGATED',
  };
  const state: CommittedGameState = {
    state_version: 4,
    state_hash: 's4',
    prev_state_hash: 's3',
    zone_states: { dummy_hand: { zone_id: 'dummy_hand', card_refs: [], commitment_hash: 'empty' } },
    groups: {}, public_bindings: {}, grants: {}, disclosure_grants: {}, controller_grants: {},
    last_transition_commitment: 't4', game_state_extension: {}, game_state_extension_hash: 'legacy',
  };
  const roster = ['north', 'south', 'east', 'west'];
  const grant = await ControllerEngine.createOwnerGrant(state, zone, 'south', 'north', ['play_card'], 'intent_grant', ['play_card'], roster);
  const granted = { ...state, controller_grants: { [grant.grant_id]: grant } };
  assert(ControllerEngine.isController(granted, zone, 'north', 'play_card', roster), 'declared scoped control not recognized');
  assert(!ControllerEngine.isController(granted, zone, 'north', 'peek', roster), 'grant widened to undeclared action');
  assert(zone.default_visibility === 'OWNER_ONLY', 'controller grant altered visibility');
  await expectReject(() => ControllerEngine.createOwnerGrant(state, zone, 'north', 'east', ['play_card'], 'bad', ['play_card'], roster), /Zone owner/, 'non-owner grant');
}

async function unoUsesSameCoordinator(): Promise<void> {
  const { coordinator, players } = await ready(await buildUnoGamePackage());
  const before = coordinator.stateLedger!.current;
  const drawBefore = before.zone_states.draw_pile.card_refs.length;
  const handBefore = before.zone_states['hand:alice'].card_refs.length;
  await coordinator.submitMechanicalIntent(await signMechanical(coordinator, players[0], 'draw_card', {}));
  let state = coordinator.stateLedger!.current;
  assert(state.zone_states.draw_pile.card_refs.length === drawBefore - 1, 'UNO draw did not consume TOP card');
  assert(state.zone_states['hand:alice'].card_refs.length === handBefore + 1, 'UNO draw did not add to actor hand');
  const card = state.zone_states['hand:alice'].card_refs[0];
  await coordinator.submitMechanicalIntent(await signMechanical(coordinator, players[0], 'play_card', { card }));
  state = coordinator.stateLedger!.current;
  assert(state.zone_states.discard_pile.card_refs.length === 1, 'UNO play did not move controlled card to discard');
  await coordinator.submitPublicGameEvent(await signEvent(coordinator, players[0], 'choose_color', { color: 'red' }));
  assert(
    coordinator.stateLedger!.getTransitionStream().map(record => record.transition_kind).join(',') === 'MECHANICAL,MECHANICAL,PUBLIC_GAME_EVENT',
    'UNO did not share generic transition stream'
  );
}

async function blindRandomBackdoorRejected(): Promise<void> {
  const packageDef = await buildOldMaidGamePackage();
  const malicious = JSON.parse(JSON.stringify(packageDef.manifest)) as GameManifestV1;
  const action = malicious.mechanicalActions.find(candidate => candidate.id === 'draw_random_from_player')!;
  action.steps[0].selection = { type: 'BY_HANDLE', param: 'chosen_card' };
  await expectReject(async () => GamePackageHost.validateManifest(malicious), /BLIND_RANDOM requires RANDOM/, 'BLIND_RANDOM BY_HANDLE');
}

async function ruleViewNotCommitted(): Promise<void> {
  const { coordinator } = await ready(await buildUnoGamePackage());
  const state = coordinator.stateLedger!.current as unknown as Record<string, unknown>;
  assert(!('derived_rule_view_hash' in state), 'Rule View hash leaked into committed state');
}

const tests: Array<[string, () => Promise<void>]> = [
  ['BLIND_RANDOM hides selected CardRef', blindRandomDoesNotLeakHandle],
  ['game-rule violation can remain mechanically valid', gameRuleViolationCanRemainMechanicallyValid],
  ['foreign CardRef is rejected', foreignHandleRejected],
  ['public game events use one StateLedger order', publicEventsShareGlobalOrder],
  ['Rule Advisor release is outside security_definition_hash', ruleModuleDoesNotChangeSecurityHash],
  ['ControllerGrant is owner-authorized and action-scoped', controllerGrantIsScoped],
  ['UNO uses same generic coordinator', unoUsesSameCoordinator],
  ['BLIND_RANDOM cannot smuggle BY_HANDLE', blindRandomBackdoorRejected],
  ['Rule View hash is not committed', ruleViewNotCommitted],
];

let failures = 0;
for (const [name, test] of tests) {
  try { await test(); console.log(`PASS  ${name}`); }
  catch (error) { failures++; console.error(`FAIL  ${name}`); console.error(error); }
}
if (failures) throw new Error(`${failures}/${tests.length} v0.10 physical-deck tests failed`);
console.log(`\n${tests.length}/${tests.length} v0.10 physical-deck tests passed.`);
