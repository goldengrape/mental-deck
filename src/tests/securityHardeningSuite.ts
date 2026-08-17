import { AtomicTransitionKernel } from '../core/atomicKernel';
import { StateLedger } from '../core/stateLedger';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { hashCanonical, MentalDeckCrypto } from '../crypto/cryptoProvider';
import {
  CardRef,
  CommittedGameState,
  OperationPlan,
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

function makeBaseState(refs: CardRef[]): CommittedGameState {
  return {
    state_version: 1,
    state_hash: 'state_parent_hash',
    prev_state_hash: 'genesis',
    zone_states: {
      hand_p1: { zone_id: 'hand_p1', card_refs: [], commitment_hash: 'empty' },
      hand_p2: { zone_id: 'hand_p2', card_refs: refs, commitment_hash: '' },
    },
    groups: {},
    public_bindings: {},
    grants: {},
    game_state_extension: {},
    game_state_extension_hash: '',
    active_workflow_id: null,
  };
}

async function testMissingRandomReceiptFailsClosed(): Promise<void> {
  const refs: CardRef[] = [
    { ref_id: 'r1', epoch: 1 },
    { ref_id: 'r2', epoch: 1 },
  ];
  const base = makeBaseState(refs);
  base.zone_states.hand_p2.commitment_hash = await hashCanonical(refs);
  base.game_state_extension_hash = await hashCanonical({});

  const zones: Record<string, ZoneDefinition> = {
    hand_p1: { zone_id: 'hand_p1', name: 'P1', owner_player_id: 'p1', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
    hand_p2: { zone_id: 'hand_p2', name: 'P2', owner_player_id: 'p2', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
  };
  const plan: OperationPlan = {
    operations: [{
      op_type: 'MOVE',
      source_zone_id: 'hand_p2',
      destination_zone_id: 'hand_p1',
      resolved_selection: {
        selection_kind: 'VERIFIED_RANDOM',
        selected_card_refs: [refs[0]],
        source_zone_id: 'hand_p2',
        workflow_id: 'wf_1',
        parent_state_hash: base.state_hash,
        evidence_ref: 'missing_receipt_hash',
      },
      placement: 'TOP',
    }],
    is_atomic: true,
    plan_hash: 'p',
  };

  await expectReject(
    () => AtomicTransitionKernel.simulatePlan(base, zones, plan, 2, 'p1', new Map(), new Set()),
    /not found/,
    'missing random receipt'
  );
}

async function testRawRandomIsNotAuthorization(): Promise<void> {
  const refs: CardRef[] = [{ ref_id: 'r1', epoch: 1 }];
  const base = makeBaseState(refs);
  base.zone_states.hand_p2.commitment_hash = await hashCanonical(refs);
  base.game_state_extension_hash = await hashCanonical({});
  const zones: Record<string, ZoneDefinition> = {
    hand_p1: { zone_id: 'hand_p1', name: 'P1', owner_player_id: 'p1', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
    hand_p2: { zone_id: 'hand_p2', name: 'P2', owner_player_id: 'p2', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
  };
  const plan: OperationPlan = {
    operations: [{
      op_type: 'MOVE', source_zone_id: 'hand_p2', destination_zone_id: 'hand_p1',
      selection: { type: 'RANDOM', card_refs: [refs[0]] }, placement: 'TOP',
    }],
    is_atomic: true,
    plan_hash: 'p',
  };
  await expectReject(
    () => AtomicTransitionKernel.simulatePlan(base, zones, plan, 1, 'p1'),
    /not authorization/,
    'raw RANDOM spec'
  );
}

async function testRandomContextMustBindSourceVector(): Promise<void> {
  const refs: CardRef[] = [{ ref_id: 'r1', epoch: 1 }, { ref_id: 'r2', epoch: 1 }];
  const context = {
    workflow_id: 'wf',
    parent_state_hash: 's',
    source_zone_id: 'hand_p2',
    source_ref_set_commitment: 'forged_commitment',
    card_count: 2,
    participant_ids: ['p1', 'p2'],
    round: 1,
  };
  const c1 = await MultipartyRandomIndexProtocol.generateCommitment('p1', context);
  const c2 = await MultipartyRandomIndexProtocol.generateCommitment('p2', context);
  await expectReject(
    () => MultipartyRandomIndexProtocol.finalizeSelection(
      context,
      { p1: c1.commitment, p2: c2.commitment },
      { p1: c1.nonce, p2: c2.nonce },
      refs
    ),
    /source_ref_set_commitment/,
    'random source commitment binding'
  );
}

async function testPrivateProjectionHidesStableHandles(): Promise<void> {
  const refs: CardRef[] = [{ ref_id: 'secret_a', epoch: 1 }, { ref_id: 'secret_b', epoch: 1 }];
  const state = makeBaseState(refs);
  state.zone_states.hand_p2.commitment_hash = await hashCanonical(refs);
  state.game_state_extension_hash = await hashCanonical({});
  const ledger = new StateLedger(state);
  const defs: Record<string, ZoneDefinition> = {
    hand_p1: { zone_id: 'hand_p1', name: 'P1', owner_player_id: 'p1', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
    hand_p2: { zone_id: 'hand_p2', name: 'P2', owner_player_id: 'p2', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
  };
  const view = ledger.projectGameView('p1', 'g', defs);
  const p2 = view.zones.find(z => z.zone_id === 'hand_p2');
  assert(p2?.card_count === 2, 'opponent card count should remain visible');
  assert((p2?.cards ?? []).length === 0, 'opponent hidden CardRef vector leaked into GameView');
}

async function testExtensionHashMismatchRejected(): Promise<void> {
  const refs: CardRef[] = [{ ref_id: 'r1', epoch: 1 }];
  const base = makeBaseState(refs);
  base.zone_states.hand_p2.commitment_hash = await hashCanonical(refs);
  base.game_state_extension_hash = await hashCanonical({});
  const zones: Record<string, ZoneDefinition> = {
    hand_p1: { zone_id: 'hand_p1', name: 'P1', owner_player_id: 'p1', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
    hand_p2: { zone_id: 'hand_p2', name: 'P2', owner_player_id: 'p2', ordering: 'UNORDERED', default_visibility: 'OWNER_ONLY' },
  };
  const candidate = await AtomicTransitionKernel.simulatePlan(
    base, zones, { operations: [], is_atomic: true, plan_hash: 'empty' }, 1, 'p1'
  );
  await expectReject(
    () => AtomicTransitionKernel.commitTransition(base, candidate, {
      next_game_state_extension: { changed: true },
      next_extension_hash: 'forged_hash',
    }),
    /extension hash mismatch/,
    'extension hash mismatch'
  );
}

async function testSimulationSignaturesFailClosed(): Promise<void> {
  const keys = await MentalDeckCrypto.generatePlayerKeys('alice', 'g');
  const payload = { actor_id: 'alice', action: 'draw', base_state_hash: 's' };
  const signature = await MentalDeckCrypto.signSemanticIntent(keys.signing.privateKey, payload);
  assert(await MentalDeckCrypto.verifySemanticIntent(keys.signing.publicKey, signature, payload), 'valid simulation signature rejected');
  assert(!(await MentalDeckCrypto.verifySemanticIntent(keys.signing.publicKey, signature, { ...payload, action: 'cheat' })), 'tampered signed payload accepted');
  assert(!(await MentalDeckCrypto.verifySemanticIntent('unknown_public_key', signature, payload)), 'unknown signing key accepted');
}

const tests: Array<[string, () => Promise<void>]> = [
  ['missing VERIFIED_RANDOM receipt fails closed', testMissingRandomReceiptFailsClosed],
  ['raw RANDOM spec has no authorization value', testRawRandomIsNotAuthorization],
  ['random context binds exact source vector', testRandomContextMustBindSourceVector],
  ['private GameView hides stable CardRef vector', testPrivateProjectionHidesStableHandles],
  ['extension hash is recomputed at commit', testExtensionHashMismatchRejected],
  ['simulation signatures reject tampering/unknown keys', testSimulationSignaturesFailClosed],
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

if (failures > 0) {
  throw new Error(`${failures}/${tests.length} security-hardening tests failed`);
}
console.log(`\n${tests.length}/${tests.length} security-hardening tests passed.`);
