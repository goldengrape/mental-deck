import { MentalDeckCrypto } from '../crypto/cryptoProvider';
import { buildBridgeGamePackage } from '../plugins/bridge/package';
import { PhysicalDeckCoordinator } from '../protocol/physicalDeckCoordinator';
import type { CardRef, PlayerIdentity, SignedMechanicalIntent } from '../types/contracts';

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(fn: () => Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await fn();
    throw new Error('expected rejection, operation succeeded');
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (message.includes('expected rejection')) throw error;
    assert(pattern.test(message), `wrong rejection: ${message}`);
  }
}

interface TestPlayer { identity: PlayerIdentity; signingPrivateKey: string }

async function makePlayer(id: string): Promise<TestPlayer> {
  const gameId = 'mental_deck.game.bridge';
  const keys = await MentalDeckCrypto.generatePlayerKeys(id, gameId);
  return {
    identity: {
      player_id: id,
      display_name: id,
      is_ai: false,
      signing_public_key: keys.signing.publicKey,
      encryption_public_key: keys.encryption.publicKey,
      pok_proof: keys.encryption.pokProof,
    },
    signingPrivateKey: keys.signing.privateKey,
  };
}

async function sign(
  coordinator: PhysicalDeckCoordinator,
  player: TestPlayer,
  actionId: string,
  parameters: Record<string, unknown>
): Promise<SignedMechanicalIntent> {
  const state = coordinator.stateLedger!.current;
  const unsigned = {
    intent_id: `bridge_${actionId}_${state.state_version}_${player.identity.player_id}`,
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

const packageDef = await buildBridgeGamePackage();
const coordinator = new PhysicalDeckCoordinator(packageDef.manifest.game.id, packageDef);
const players = Object.fromEntries(await Promise.all(['north', 'east', 'south', 'west'].map(async id => [id, await makePlayer(id)]))) as Record<string, TestPlayer>;
for (const id of ['north', 'east', 'south', 'west']) await coordinator.registerPlayer(players[id].identity);
await coordinator.lockRoster();
const definition = await coordinator.lockSecurityDefinition();
const refs: CardRef[] = Array.from({ length: 52 }, (_, index) => ({ ref_id: `bridge_${index}`, epoch: 1 }));
await coordinator.initializeOpaqueState(refs);

const southCard = coordinator.stateLedger!.current.zone_states['hand:south'].card_refs[0];
await expectReject(
  () => coordinator.submitMechanicalIntent(sign(coordinator, players.north, 'play_card', { hand_player_id: 'south', card: southCard })),
  /not a controller/
);

const grantRecord = await coordinator.submitMechanicalIntent(
  await sign(coordinator, players.south, 'grant_hand_control', { controller_player_id: 'north' })
);
assert(grantRecord.transition_kind === 'MECHANICAL', 'controller grant was not committed as mechanical transition');
const grantedState = coordinator.stateLedger!.current;
const grants = Object.values(grantedState.controller_grants ?? {});
assert(grants.length === 1, 'expected exactly one ControllerGrant');
assert(grants[0].grantor_player_id === 'south' && grants[0].controller_player_id === 'north', 'grant owner/controller mismatch');
assert(grants[0].allowed_action_ids.join(',') === 'play_card', 'grant scope widened beyond play_card');
assert(coordinator.zoneDefinitions['hand:south'].default_visibility === 'OWNER_ONLY', 'delegated control changed hand visibility');

const playRecord = await coordinator.submitMechanicalIntent(
  await sign(coordinator, players.north, 'play_card', { hand_player_id: 'south', card: southCard })
);
assert(playRecord.transition_kind === 'MECHANICAL', 'delegated play was not committed');
assert(coordinator.stateLedger!.current.zone_states.current_trick.card_refs.length === 1, 'delegated controller failed to play one real South card');

const eastCard = coordinator.stateLedger!.current.zone_states['hand:east'].card_refs[0];
await expectReject(
  () => coordinator.submitMechanicalIntent(sign(coordinator, players.north, 'play_card', { hand_player_id: 'east', card: eastCard })),
  /not a controller/
);

console.log('PASS  Bridge owner-authorized action-scoped Dummy control');
