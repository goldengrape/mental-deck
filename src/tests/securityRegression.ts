import { AtomicTransitionKernel } from '../core/atomicKernel';
import { StateLedger } from '../core/stateLedger';
import { hashCanonical, MentalDeckCrypto } from '../crypto/cryptoProvider';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { OLD_MAID_PLUGIN_DESCRIPTOR } from '../plugins/oldMaid/definition';
import { GameCoordinator } from '../protocol/coordinator';
import {
  CardRef,
  CommittedGameState,
  OperationPlan,
  SignedSemanticIntent,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';

type AsyncTest = () => Promise<void>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function expectReject(
  action: () => Promise<unknown>,
  messageIncludes?: string
): Promise<void> {
  let rejected = false;
  try {
    await action();
  } catch (error) {
    rejected = true;
    if (messageIncludes) {
      const message = (error as Error).message;
      assert(
        message.includes(messageIncludes),
        `Expected error containing "${messageIncludes}", got "${message}"`
      );
    }
  }
  assert(rejected, 'Expected operation to reject');
}

async function makeState(
  zones: Record<string, ZoneState>,
  extension: Record<string, unknown> = {}
): Promise<CommittedGameState> {
  const extensionHash = await hashCanonical(extension);
  const stateData = {
    state_version: 0,
    prev_state_hash: 'GENESIS',
    zone_states: zones,
    groups: {},
    public_bindings: {},
    grants: {},
    game_state_extension: extension,
    game_state_extension_hash: extensionHash,
  };
  return {
    ...stateData,
    state_hash: await hashCanonical(stateData),
    active_workflow_id: null,
  };
}

const tests: Array<[string, AsyncTest]> = [
  [
    'ECDSA intent signatures bind all semantic fields',
    async () => {
      const keys = await MentalDeckCrypto.generatePlayerKeys('alice', 'g1');
      const unsigned: Omit<SignedSemanticIntent, 'signature'> = {
        intent_id: 'intent-1',
        actor_id: 'alice',
        plugin_id: OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id,
        action_type: 'end_turn',
        parameters: { x: 1 },
        base_state_hash: 'state-a',
        base_state_version: 3,
        timestamp: 123,
      };
      const signature = await MentalDeckCrypto.signIntent(
        keys.signing.privateKey,
        unsigned
      );
      const signed: SignedSemanticIntent = { ...unsigned, signature };
      assert(
        await MentalDeckCrypto.verifyIntentSignature(
          keys.signing.publicKey,
          signed
        ),
        'Valid signature did not verify'
      );
      assert(
        !(await MentalDeckCrypto.verifyIntentSignature(
          keys.signing.publicKey,
          { ...signed, parameters: { x: 2 } }
        )),
        'Tampered intent parameters still verified'
      );
    },
  ],
  [
    'proof-of-possession cannot be replaced by arbitrary text',
    async () => {
      const keys = await MentalDeckCrypto.generatePlayerKeys('alice', 'g2');
      assert(
        await MentalDeckCrypto.verifyPoK(
          'alice',
          keys.encryption.publicKey,
          keys.encryption.pokProof
        ),
        'Valid proof-of-possession failed'
      );
      const forged = `${keys.encryption.pokProof.slice(0, -2)}00`;
      assert(
        !(await MentalDeckCrypto.verifyPoK(
          'alice',
          keys.encryption.publicKey,
          forged
        )),
        'Forged proof-of-possession verified'
      );
    },
  ],
  [
    'external TOP/BOTTOM/ALL/BY_HANDLE resolved selections are rejected',
    async () => {
      const refs: CardRef[] = [
        { ref_id: 'c1', epoch: 1 },
        { ref_id: 'c2', epoch: 1 },
      ];
      const zones: Record<string, ZoneDefinition> = {
        deck: {
          zone_id: 'deck',
          name: 'Deck',
          ordering: 'ORDERED',
          default_visibility: 'PUBLIC',
        },
        hand: {
          zone_id: 'hand',
          name: 'Hand',
          ordering: 'UNORDERED',
          default_visibility: 'PUBLIC',
        },
      };
      const state = await makeState({
        deck: {
          zone_id: 'deck',
          card_refs: refs,
          commitment_hash: await hashCanonical(refs),
        },
        hand: {
          zone_id: 'hand',
          card_refs: [],
          commitment_hash: await hashCanonical([]),
        },
      });
      const plan: OperationPlan = {
        operations: [
          {
            op_type: 'MOVE',
            source_zone_id: 'deck',
            destination_zone_id: 'hand',
            resolved_selection: {
              selection_kind: 'TOP',
              selected_card_refs: [refs[1]],
              source_zone_id: 'deck',
            },
            placement: 'TOP',
          },
        ],
        is_atomic: true,
        plan_hash: 'external-top',
      };
      await expectReject(
        () => AtomicTransitionKernel.simulatePlan(state, zones, plan, 2, 'alice'),
        'forbidden'
      );
    },
  ],
  [
    'VERIFIED_RANDOM requires an authoritative receipt',
    async () => {
      const refs: CardRef[] = [{ ref_id: 'c1', epoch: 1 }];
      const zoneDefs: Record<string, ZoneDefinition> = {
        source: {
          zone_id: 'source',
          name: 'Source',
          ordering: 'UNORDERED',
          default_visibility: 'OWNER_ONLY',
          owner_player_id: 'bob',
        },
        dest: {
          zone_id: 'dest',
          name: 'Dest',
          ordering: 'UNORDERED',
          default_visibility: 'OWNER_ONLY',
          owner_player_id: 'alice',
        },
      };
      const state = await makeState({
        source: {
          zone_id: 'source',
          card_refs: refs,
          commitment_hash: await hashCanonical(refs),
        },
        dest: {
          zone_id: 'dest',
          card_refs: [],
          commitment_hash: await hashCanonical([]),
        },
      });
      const plan: OperationPlan = {
        operations: [
          {
            op_type: 'MOVE',
            source_zone_id: 'source',
            destination_zone_id: 'dest',
            resolved_selection: {
              selection_kind: 'VERIFIED_RANDOM',
              selected_card_refs: refs,
              source_zone_id: 'source',
              workflow_id: 'wf1',
              parent_state_hash: state.state_hash,
              evidence_ref: 'missing-receipt',
            },
            placement: 'TOP',
          },
        ],
        is_atomic: true,
        plan_hash: 'missing-receipt-plan',
      };
      await expectReject(
        () =>
          AtomicTransitionKernel.simulatePlan(
            state,
            zoneDefs,
            plan,
            1,
            'alice',
            new Map(),
            new Set()
          ),
        'not found'
      );
    },
  ],
  [
    'random receipts bind the exact source commitment and selected ref',
    async () => {
      const refs: CardRef[] = [
        { ref_id: 'r1', epoch: 2 },
        { ref_id: 'r2', epoch: 2 },
      ];
      const sourceCommitment = await hashCanonical(refs);
      const context = {
        workflow_id: 'wf-random',
        parent_state_hash: 'parent',
        source_zone_id: 'hand_bob',
        source_ref_set_commitment: sourceCommitment,
        card_count: refs.length,
        participant_ids: ['alice', 'bob'],
        round: 1,
      };
      const a = await MultipartyRandomIndexProtocol.generateCommitment(
        'alice',
        context
      );
      const b = await MultipartyRandomIndexProtocol.generateCommitment(
        'bob',
        context
      );
      const receipt = await MultipartyRandomIndexProtocol.finalizeSelection(
        context,
        { alice: a.commitment, bob: b.commitment },
        { alice: a.nonce, bob: b.nonce },
        refs
      );
      assert(
        await MultipartyRandomIndexProtocol.verifyReceipt(
          receipt,
          context,
          refs
        ),
        'Valid receipt failed verification'
      );
      const swapped = [refs[1], refs[0]];
      assert(
        !(await MultipartyRandomIndexProtocol.verifyReceipt(
          receipt,
          context,
          swapped
        )),
        'Receipt verified against a different source vector'
      );
    },
  ],
  [
    'candidate mutation is rejected unless explicitly resealed',
    async () => {
      const ref: CardRef = { ref_id: 'c1', epoch: 1 };
      const zoneDefs: Record<string, ZoneDefinition> = {
        deck: {
          zone_id: 'deck',
          name: 'Deck',
          ordering: 'ORDERED',
          default_visibility: 'PUBLIC',
        },
        hand: {
          zone_id: 'hand',
          name: 'Hand',
          ordering: 'UNORDERED',
          default_visibility: 'PUBLIC',
        },
      };
      const state = await makeState({
        deck: {
          zone_id: 'deck',
          card_refs: [ref],
          commitment_hash: await hashCanonical([ref]),
        },
        hand: {
          zone_id: 'hand',
          card_refs: [],
          commitment_hash: await hashCanonical([]),
        },
      });
      const candidate = await AtomicTransitionKernel.simulatePlan(
        state,
        zoneDefs,
        {
          operations: [
            {
              op_type: 'MOVE',
              source_zone_id: 'deck',
              destination_zone_id: 'hand',
              selection: { type: 'TOP', count: 1 },
              placement: 'TOP',
            },
          ],
          is_atomic: true,
          plan_hash: 'move-top',
        },
        1,
        'alice'
      );
      candidate.events_summary.push('tampered');
      const extension = {};
      await expectReject(
        () =>
          AtomicTransitionKernel.commitTransition(state, candidate, {
            next_game_state_extension: extension,
            next_extension_hash: hashCanonical(extension) as unknown as string,
          }),
        'integrity'
      );
    },
  ],
  [
    'StateLedger rejects a forged state hash',
    async () => {
      const base = await makeState({});
      const ledger = new StateLedger(base);
      const forged: CommittedGameState = {
        ...base,
        state_version: 1,
        prev_state_hash: base.state_hash,
        state_hash: 'forged',
      };
      await expectReject(() => ledger.appendState(forged), 'state hash mismatch');
    },
  ],
  [
    'unauthorized viewers do not receive hidden CardRef vectors',
    async () => {
      const ref: CardRef = { ref_id: 'secret-ref', epoch: 1 };
      const state = await makeState({
        bob_hand: {
          zone_id: 'bob_hand',
          card_refs: [ref],
          commitment_hash: await hashCanonical([ref]),
        },
      });
      const ledger = new StateLedger(state);
      const view = ledger.projectGameView('alice', 'g', {
        bob_hand: {
          zone_id: 'bob_hand',
          name: 'Bob Hand',
          owner_player_id: 'bob',
          ordering: 'UNORDERED',
          default_visibility: 'OWNER_ONLY',
        },
      });
      assert(view.zones[0].card_count === 1, 'Card count should remain visible');
      assert(view.zones[0].cards === undefined, 'Hidden CardRef vector leaked');
    },
  ],
  [
    'READY quorum ignores fake player ids and intent spoofing is rejected',
    async () => {
      const coordinator = new GameCoordinator('security-e2e');
      await coordinator.initializeRoom();
      const alice = await MentalDeckCrypto.generatePlayerKeys('alice', 'security-e2e');
      const bob = await MentalDeckCrypto.generatePlayerKeys('bob', 'security-e2e');
      for (const [id, keys] of [
        ['alice', alice],
        ['bob', bob],
      ] as const) {
        await coordinator.registerPlayer({
          player_id: id,
          display_name: id,
          is_ai: false,
          signing_public_key: keys.signing.publicKey,
          encryption_public_key: keys.encryption.publicKey,
          pok_proof: keys.encryption.pokProof,
        });
      }
      await coordinator.lockRoster();
      await coordinator.lockDefinition();
      await coordinator.setupCryptoKeys();
      await coordinator.bootstrapPrivacyPool();
      const privateKeys = new Map<string, string>([
        ['alice', alice.encryption.privateKey],
        ['bob', bob.encryption.privateKey],
      ]);
      await coordinator.executeVerifiableShuffle(privateKeys);
      const genesis = await coordinator.executeInitialAllocation();

      await expectReject(
        () => coordinator.submitInitialStateConfirmation('fake', genesis.state_hash),
        'not a member'
      );
      assert(coordinator.initialConfirmations.size === 0, 'Fake confirmation polluted quorum');

      await coordinator.submitInitialStateConfirmation('alice', genesis.state_hash);
      const ready = await coordinator.submitInitialStateConfirmation(
        'bob',
        genesis.state_hash
      );
      assert(ready && coordinator.phase === 'READY', 'Real roster failed READY ceremony');

      const forgedIntent: SignedSemanticIntent = {
        intent_id: 'forged-intent',
        actor_id: 'alice',
        plugin_id: OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id,
        action_type: 'draw_random_from_next_player',
        parameters: {},
        base_state_hash: genesis.state_hash,
        base_state_version: genesis.state_version,
        signature: '00',
        timestamp: Date.now(),
      };
      await expectReject(
        () => coordinator.proposeGameIntent(forgedIntent, privateKeys),
        'Invalid semantic intent signature'
      );
    },
  ],
];

async function main(): Promise<void> {
  let failures = 0;
  for (const [name, test] of tests) {
    try {
      await test();
      console.log(`✓ ${name}`);
    } catch (error) {
      failures += 1;
      console.error(`✗ ${name}`);
      console.error(error);
    }
  }

  console.log(`\n${tests.length - failures}/${tests.length} security regressions passed.`);
  if (failures > 0) process.exitCode = 1;
}

void main();
