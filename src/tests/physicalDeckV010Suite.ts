import { ControllerEngine } from '../core/controllerEngine';
import { hashCanonical, MentalDeckCrypto } from '../crypto/cryptoProvider';
import { GamePackageHost, makePackageDescriptor } from '../plugins/gamePackageHost';
import { buildOldMaidGamePackage, OLD_MAID_GAME_MANIFEST } from '../plugins/oldMaid/package';
import { buildUnoGamePackage } from '../plugins/uno/package';
import { PhysicalDeckCoordinator } from '../protocol/physicalDeckCoordinator';
import {
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
    assert(pattern.test(message), `${label}: wrong rejection message: ${message}`);
  }
}

interface TestPlayer {
  identity: PlayerIdentity;
  signingPrivateKey: string;
}

async function makePlayers(gameId: string, ids: string[]): Promise<TestPlayer[]> {
  const players: TestPlayer[] = [];
  for (const id of ids) {
    const keys = await MentalDeckCrypto.generatePlayerKeys(id, gameId);
    players.push({
      identity: {
        player_id: id,
        display_name: id.toUpperCase(),
        is_ai: id.includes('ai'),
        signing_public_key: keys.signing.publicKey,
        encryption_public_key: keys.encryption.publicKey,
        pok_proof: keys.encryption.pokProof,
      },
      signingPrivateKey: keys.signing.privateKey,
    });
  }
  return players;
}

function opaqueRefs(count: number): CardRef[] {
  return Array.from({ length: count }, (_, index) => ({ ref_id: `opaque_${index.toString().padStart(3, '0')}`, epoch: 1 }));
}

async function readyCoordinator(packageDef: GamePackage, ids = ['alice', 'bob', 'charlie_ai']): Promise<{
  coordinator: PhysicalDeckCoordinator;
  players: TestPlayer[];
}> {
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
  return {
    ...unsigned,
    signature: await MentalDeckCrypto.signSemanticIntent(player.signingPrivateKey, unsigned),
  };
}

async function signPublicEvent(
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
  return {
    ...unsigned,
    signature: await MentalDeckCrypto.signSemanticIntent(player.signingPrivateKey, unsigned),
  };
}

async function testOldMaidBlindRandomIsMechanicalAndPrivate(): Promise<void> {
  const { coordinator, players } = await readyCoordinator(await buildOldMaidGamePackage());
  const before = coordinator.stateLedger!.current;
  const aliceBefore = before.zone_states.hand_alice.card_refs.length;
  const bobBeforeRefs = before.zone_states.hand_bob.card_refs.map(ref => ({ ...ref }));
  const intent = await signMechanical(coordinator, players[0], 'draw_random_from_player', { target_player_id: 'bob' });
  const record = await coordinator.submitMechanicalIntent(intent);
  const after = coordinator.stateLedger!.current;
  assert(after.zone_states.hand_alice.card_refs.length === aliceBefore + 1, 'blind random draw did not add exactly one card to actor hand');
  assert(after.zone_states.hand_bob.card_refs.length === bobBeforeRefs.length - 1, 'blind random draw did not remove exactly one target card');

  const afterBobIds = new Set(after.zone_states.hand_bob.card_refs.map(ref => ref.ref_id));
  const selected = bobBeforeRefs.find(ref => !afterBobIds.has(ref.ref_id));
  assert(!!selected, 'could not identify moved ref in internal state for test');
  assert(!JSON.stringify(record.public_payload).includes(selected.ref_id), 'public transition leaked the hidden randomly selected CardRef');
  assert(record.evidence_refs.length === 1, 'blind random transition must bind one random receipt');
}

async function testOldMaidRuleViolationDoesNotBecomeCoreAuthorization(): Promise<void> {
  const { coordinator, players } = await readyCoordinator(await buildOldMaidGamePackage());
  const hand = coordinator.stateLedger!.current.zone_states.hand_alice.card_refs;
  const claimed = [hand[0], hand[1]];
  const intent = await signMechanical(coordinator, players[0], 'discard_claim', { cards: claimed });
  await coordinator.submitMechanicalIntent(intent);
  const state = coordinator.stateLedger!.current;
  assert(state.zone_states.discarded_pairs.card_refs.length === 2, 'mechanically valid pair claim should move two real controlled cards');
  assert(state.disclosure_grants && Object.keys(state.disclosure_grants).length === 1, 'public claim should create disclosure authorization');
}

async function testCannotUseForeignHandle(): Promise<void> {
  const { coordinator, players } = await readyCoordinator(await buildOldMaidGamePackage());
  const bobCards = coordinator.stateLedger!.current.zone_states.hand_bob.card_refs;
  const intent = await signMechanical(coordinator, players[0], 'discard_claim', { cards: [bobCards[0], bobCards[1]] });
  await expectReject(() => coordinator.submitMechanicalIntent(intent), /does not exactly exist|not authorized/, 'foreign BY_HANDLE');
}

async function testPublicGameEventsShareStateLedgerOrder(): Promise<void> {
  const { coordinator, players } = await readyCoordinator(await buildOldMaidGamePackage());
  const first = await signPublicEvent(coordinator, players[0], 'end_turn', {});
  const staleTwin = { ...first, event_id: `${first.event_id}_stale` };
  const { signature: _ignored, ...unsignedTwin } = staleTwin;
  staleTwin.signature = await MentalDeckCrypto.signSemanticIntent(players[0].signingPrivateKey, unsignedTwin);

  const record = await coordinator.submitPublicGameEvent(first);
  assert(record.state_version === 1, 'first public event should advance global state version');
  assert(coordinator.stateLedger!.getTransitionStream().length === 1, 'public event missing from unified transition stream');
  await expectReject(() => coordinator.submitPublicGameEvent(staleTwin), /stale|wrong state/, 'stale public game event');
}

async function testRuleModuleHashDoesNotChangeSecurityDefinition(): Promise<void> {
  const basePackage = await buildOldMaidGamePackage();
  const changedManifest: GameManifestV1 = {
    ...OLD_MAID_GAME_MANIFEST,
    modules: { ...(OLD_MAID_GAME_MANIFEST.modules ?? {}), rules: './different-rule-advisor.ts' },
  };
  const changedPackage: GamePackage = {
    descriptor: await makePackageDescriptor(changedManifest),
    manifest: changedManifest,
  };
  const players = await makePlayers(basePackage.manifest.game.id, ['alice', 'bob', 'charlie_ai']);
  const rosterPlayers = players.map(player => player.identity);
  const roster = { players: rosterPlayers, roster_hash: await hashCanonical(rosterPlayers), locked_at: 0 };
  const config = { min_players: 2, max_players: 6 };
  const a = await GamePackageHost.buildSecurityDefinition(basePackage, roster, config);
  const b = await GamePackageHost.buildSecurityDefinition(changedPackage, roster, config);
  assert(a.security_definition_hash === b.security_definition_hash, 'Rule Advisor release path changed security_definition_hash');
  assert(a.package_release_hash !== b.package_release_hash, 'Rule Advisor release path must change package_release_hash');
}

async function testControllerGrantIsOwnerAuthorizedAndActionScoped(): Promise<void> {
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
    groups: {},
    public_bindings: {},
    grants: {},
    disclosure_grants: {},
    controller_grants: {},
    last_transition_commitment: 't4',
    game_state_extension: {},
    game_state_extension_hash: 'legacy',
  };
  const grant = await ControllerEngine.createOwnerGrant(
    state, zone, 'south', 'north', ['play_card'], 'intent_grant', ['play_card'], ['north', 'south', 'east', 'west']
  );
  const grantedState = { ...state, controller_grants: { [grant.grant_id]: grant } };
  assert(ControllerEngine.isController(grantedState, zone, 'north', 'play_card', ['north', 'south', 'east', 'west']), 'scoped declarer control not recognized');
  assert(!ControllerEngine.isController(grantedState, zone, 'north', 'peek', ['north', 'south', 'east', 'west']), 'controller grant incorrectly widened action scope');
  assert(zone.default_visibility === 'OWNER_ONLY', 'controller grant changed Zone visibility');
  await expectReject(
    () => ControllerEngine.createOwnerGrant(state, zone, 'north', 'east', ['play_card'], 'bad', ['play_card'], ['north', 'south', 'east', 'west']),
    /Zone owner/,
    'non-owner grant'
  );
}

async function testUnoUsesSameGenericCoordinator(): Promise<void> {
  const { coordinator, players } = await readyCoordinator(await buildUnoGamePackage());
  const before = coordinator.stateLedger!.current;
  const drawBefore = before.zone_states.draw_pile.card_refs.length;
  const handBefore = before.zone_states.hand_alice.card_refs.length;
  const draw = await signMechanical(coordinator, players[0], 'draw_card', {});
  await coordinator.submitMechanicalIntent(draw);
  let state = coordinator.stateLedger!.current;
  assert(state.zone_states.draw_pile.card_refs.length === drawBefore - 1, 'UNO draw did not consume TOP card');
  assert(state.zone_states.hand_alice.card_refs.length === handBefore + 1, 'UNO draw did not add to actor hand');

  const card = state.zone_states.hand_alice.card_refs[0];
  const play = await signMechanical(coordinator, players[0], 'play_card', { card });
  await coordinator.submitMechanicalIntent(play);
  state = coordinator.stateLedger!.current;
  assert(state.zone_states.discard_pile.card_refs.length === 1, 'UNO play did not move a real controlled card to public discard');

  const choose = await signPublicEvent(coordinator, players[0], 'choose_color', { color: 'red' });
  await coordinator.submitPublicGameEvent(choose);
  assert(coordinator.stateLedger!.getTransitionStream().map(record => record.transition_kind).join(',') === 'MECHANICAL,MECHANICAL,PUBLIC_GAME_EVENT', 'UNO did not use unified generic transition stream');
}

async function testManifestRejectsBlindRandomHandleBackdoor(): Promise<void> {
  const packageDef = await buildOldMaidGamePackage();
  const malicious = JSON.parse(JSON.stringify(packageDef.manifest)) as GameManifestV1;
  const action = malicious.mechanicalActions.find(candidate => candidate.id === 'draw_random_from_player')!;
  action.steps[0].selection = { type: 'BY_HANDLE', param: 'chosen_card' };
  await expectReject(async () => GamePackageHost.validateManifest(malicious), /BLIND_RANDOM requires RANDOM/, 'BLIND_RANDOM BY_HANDLE backdoor');
}

async function testCommittedStateHasNoRuleViewHash(): Promise<void> {
  const { coordinator } = await readyCoordinator(await buildUnoGamePackage());
  const state = coordinator.stateLedger!.current as unknown as Record<string, unknown>;
  assert(!('derived_rule_view_hash' in state), 'Rule View hash leaked back into committed Core state');
}

const tests: Array<[string, () => Promise<void>]> = [
  ['Old Maid BLIND_RANDOM is mechanical and does not leak selected handle', testOldMaidBlindRandomIsMechanicalAndPrivate],
  ['Old Maid false pair claim can be mechanically valid without Core rule proof', testOldMaidRuleViolationDoesNotBecomeCoreAuthorization],
  ['foreign CardRef cannot be played through controlled action', testCannotUseForeignHandle],
  ['public game events share StateLedger total order and stale-reject', testPublicGameEventsShareStateLedgerOrder],
  ['Rule Advisor release changes package hash but not security definition hash', testRuleModuleHashDoesNotChangeSecurityDefinition],
  ['ControllerGrant is owner-authorized, action-scoped and visibility-neutral', testControllerGrantIsOwnerAuthorizedAndActionScoped],
  ['UNO runs through the same generic coordinator', testUnoUsesSameGenericCoordinator],
  ['manifest rejects BLIND_RANDOM BY_HANDLE backdoor', testManifestRejectsBlindRandomHandleBackdoor],
  ['committed state contains no Rule View hash', testCommittedStateHasNoRuleViewHash],
];

let failures = 0;
for (const [name, test] of tests) {
  try {
    await test();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.error(`FAIL  ${name}`);
    console.error(error);
  }
}
if (failures > 0) throw new Error(`${failures}/${tests.length} v0.10 physical-deck tests failed`);
console.log(`\n${tests.length}/${tests.length} v0.10 physical-deck tests passed.`);
