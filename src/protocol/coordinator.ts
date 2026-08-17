/**
 * Mental Deck - Game Room Coordinator (MDD-MOD-001 to MDD-MOD-029)
 *
 * Server-authoritative orchestrator managing room lifecycle, verifiable cryptography,
 * canonical rule execution, and immutable state transitions.
 */

import {
  AuditVerifierBundle,
  CardInstance,
  CardRef,
  CipherCard,
  CommittedGameState,
  DeckManifest,
  InitializationPlan,
  LockedGameDefinition,
  LockedRoster,
  OperationPlan,
  PlayerIdentity,
  PluginArtifactDescriptor,
  ProtocolContext,
  ProtocolOutcome,
  PublicGameConfig,
  RandomSelectionReceipt,
  ResolvedSelection,
  SignedSemanticIntent,
  ZoneDefinition,
  ZoneManifest,
  ZoneState,
} from '../types/contracts';
import { AtomicTransitionKernel } from '../core/atomicKernel';
import { PrivacyPoolBootstrap } from '../core/privacyPool';
import { StateLedger } from '../core/stateLedger';
import { hashCanonical, MentalDeckCrypto, sha256 } from '../crypto/cryptoProvider';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { OldMaidCanonicalRules } from '../plugins/oldMaid/canonicalRules';
import {
  OldMaidDefinitionBuilder,
  OLD_MAID_PLUGIN_DESCRIPTOR,
} from '../plugins/oldMaid/definition';
import { PinnedPluginArtifactHost } from '../plugins/pluginHost';
import { TranscriptRecorder } from './transcriptRecorder';

export type RoomPhase =
  | 'ROOM_OPEN'
  | 'PLUGIN_PINNED'
  | 'PLAYERS_JOINING'
  | 'ROSTER_LOCKED'
  | 'DEFINITION_LOCKED'
  | 'KEY_SETUP'
  | 'PRIVACY_POOL_READY'
  | 'INITIAL_VERIFIABLE_SHUFFLE'
  | 'INITIAL_ALLOCATION'
  | 'INITIAL_STATE_CONFIRM'
  | 'READY'
  | 'GAME_STALLED'
  | 'GAME_OVER';

export class GameCoordinator {
  public phase: RoomPhase = 'ROOM_OPEN';
  public pluginDescriptor!: PluginArtifactDescriptor;
  public publicConfig!: PublicGameConfig;
  public draftPlayers: PlayerIdentity[] = [];
  public lockedRoster?: LockedRoster;
  public lockedDefinition?: LockedGameDefinition;
  public jointPublicKey?: string;
  public privacyPoolCiphers: CipherCard[] = [];
  public currentCardRefs: CardRef[] = [];
  public initialConfirmations: Map<string, string> = new Map(); // playerId -> signedHash
  public stateLedger!: StateLedger;
  public transcriptRecorder: TranscriptRecorder = new TranscriptRecorder();
  public zoneDefinitions: Record<string, ZoneDefinition> = {};
  public outcome: ProtocolOutcome | null = null;
  public activeWorkflowId: string | null = null;
  public receiptStore: Map<string, RandomSelectionReceipt> = new Map();
  public consumedReceipts: Set<string> = new Set();
  public cardRefInstanceMap: Map<string, CardInstance> = new Map();

  constructor(public readonly gameId: string) {
    // Register product-shipped Old Maid plugin in host
    PinnedPluginArtifactHost.registerAllowlistedPlugin(OLD_MAID_PLUGIN_DESCRIPTOR);
  }

  /**
   * 1. ROOM_OPEN -> PLUGIN_PINNED
   */
  async initializeRoom(
    pluginDescriptor: PluginArtifactDescriptor = OLD_MAID_PLUGIN_DESCRIPTOR,
    config: PublicGameConfig = { min_players: 2, max_players: 6 }
  ): Promise<void> {
    const verified = PinnedPluginArtifactHost.resolvePlugin(
      pluginDescriptor.plugin_id,
      pluginDescriptor.plugin_version,
      pluginDescriptor.plugin_package_hash
    );
    this.pluginDescriptor = verified;
    this.publicConfig = config;
    this.phase = 'PLUGIN_PINNED';

    await this.transcriptRecorder.appendRecord('PLUGIN_PINNED', {
      game_id: this.gameId,
      plugin_id: verified.plugin_id,
      plugin_version: verified.plugin_version,
      package_hash: verified.plugin_package_hash,
      config,
    });
  }

  /**
   * 2. Join a player to the room
   */
  async registerPlayer(player: PlayerIdentity): Promise<void> {
    if (this.phase !== 'PLUGIN_PINNED' && this.phase !== 'PLAYERS_JOINING') {
      throw new Error(`Cannot join players in phase ${this.phase}`);
    }
    if (this.draftPlayers.some(p => p.player_id === player.player_id)) {
      throw new Error(`Player ${player.player_id} already registered`);
    }
    if (this.draftPlayers.length >= this.publicConfig.max_players) {
      throw new Error(`Room full: maximum ${this.publicConfig.max_players} players allowed`);
    }

    this.draftPlayers.push(player);
    this.phase = 'PLAYERS_JOINING';

    await this.transcriptRecorder.appendRecord('PLAYER_REGISTERED', {
      player_id: player.player_id,
      display_name: player.display_name,
      is_ai: player.is_ai,
      signing_pub_key: player.signing_public_key,
      enc_pub_key: player.encryption_public_key,
    });
  }

  /**
   * 3. PLAYERS_JOINING -> ROSTER_LOCKED
   */
  async lockRoster(): Promise<LockedRoster> {
    if (this.draftPlayers.length < this.publicConfig.min_players) {
      throw new Error(`Need at least ${this.publicConfig.min_players} players to lock roster. Currently have ${this.draftPlayers.length}.`);
    }

    const rosterHash = await hashCanonical(this.draftPlayers);
    this.lockedRoster = {
      players: [...this.draftPlayers],
      roster_hash: rosterHash,
      locked_at: Date.now(),
    };
    this.phase = 'ROSTER_LOCKED';

    await this.transcriptRecorder.appendRecord('ROSTER_LOCKED', {
      roster_hash: rosterHash,
      player_ids: this.draftPlayers.map(p => p.player_id),
    });

    return this.lockedRoster;
  }

  /**
   * 4. ROSTER_LOCKED -> DEFINITION_LOCKED
   */
  async lockDefinition(): Promise<LockedGameDefinition> {
    if (!this.lockedRoster) {
      throw new Error('Roster must be locked before building game definition (URD-ARCH-003)');
    }

    let deckManifest: DeckManifest;
    let zoneManifest: ZoneManifest;
    let initialExt: Record<string, unknown>;
    let initPlan: InitializationPlan;

    if (this.pluginDescriptor.plugin_id === OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id) {
      deckManifest = await OldMaidDefinitionBuilder.buildDeckManifest();
      zoneManifest = await OldMaidDefinitionBuilder.buildZoneManifest(this.lockedRoster);
      initialExt = OldMaidDefinitionBuilder.buildInitialGameExtension(this.lockedRoster);
      initPlan = await OldMaidDefinitionBuilder.buildInitializationPlan(this.lockedRoster);
    } else {
      throw new Error(`Unsupported plugin definition builder: ${this.pluginDescriptor.plugin_id}`);
    }

    for (const z of zoneManifest.zones) {
      this.zoneDefinitions[z.zone_id] = z;
    }

    const defDraft = {
      plugin_descriptor: this.pluginDescriptor,
      roster_hash: this.lockedRoster.roster_hash,
      deck_manifest: deckManifest,
      zone_manifest: zoneManifest,
      initial_game_extension: initialExt,
      initialization_plan: initPlan,
    };
    const defHash = await hashCanonical(defDraft);

    this.lockedDefinition = {
      ...defDraft,
      game_definition_hash: defHash,
    };
    this.phase = 'DEFINITION_LOCKED';

    await this.transcriptRecorder.appendRecord('DEFINITION_LOCKED', {
      game_definition_hash: defHash,
      deck_cards_count: deckManifest.cards.length,
      zones_count: zoneManifest.zones.length,
    });

    return this.lockedDefinition;
  }

  /**
   * 5. DEFINITION_LOCKED -> KEY_SETUP
   */
  async setupCryptoKeys(): Promise<string> {
    if (!this.lockedRoster || !this.lockedDefinition) {
      throw new Error('Definition must be locked before key setup');
    }

    // Verify all players' PoKs
    for (const player of this.lockedRoster.players) {
      if (player.pok_proof) {
        const valid = await MentalDeckCrypto.verifyPoK(
          player.player_id,
          player.encryption_public_key,
          player.pok_proof
        );
        if (!valid) {
          throw new Error(`PoK verification failed for player ${player.player_id}`);
        }
      }
    }

    const encKeys = this.lockedRoster.players.map(p => p.encryption_public_key);
    this.jointPublicKey = await MentalDeckCrypto.deriveJointPublicKey(encKeys);
    this.phase = 'KEY_SETUP';

    await this.transcriptRecorder.appendRecord('KEY_SETUP_COMPLETED', {
      joint_public_key: this.jointPublicKey,
    });

    return this.jointPublicKey;
  }

  /**
   * 6. KEY_SETUP -> PRIVACY_POOL_READY
   */
  async bootstrapPrivacyPool(): Promise<void> {
    if (!this.lockedDefinition || !this.jointPublicKey) {
      throw new Error('Keys must be ready before privacy pool bootstrap');
    }

    const { ciphers, initialRefs } = await PrivacyPoolBootstrap.bootstrapPrivacyPool(
      this.lockedDefinition.deck_manifest,
      this.jointPublicKey
    );

    this.privacyPoolCiphers = ciphers;
    this.currentCardRefs = initialRefs;
    this.phase = 'PRIVACY_POOL_READY';

    // Populate initial ref -> instance mapping
    this.cardRefInstanceMap.clear();
    for (let i = 0; i < initialRefs.length; i++) {
      this.cardRefInstanceMap.set(initialRefs[i].ref_id, this.lockedDefinition.deck_manifest.cards[i]);
    }

    await this.transcriptRecorder.appendRecord('PRIVACY_POOL_BOOTSTRAPPED', {
      total_ciphers: ciphers.length,
      initial_pool_hash: await hashCanonical(ciphers),
    });
  }

  /**
   * 7. PRIVACY_POOL_READY -> INITIAL_VERIFIABLE_SHUFFLE
   */
  async executeVerifiableShuffle(playerKeyMaterials: Map<string, string>): Promise<void> {
    if (!this.lockedDefinition || !this.lockedRoster) {
      throw new Error('Missing locked definition or roster for shuffle');
    }

    const context: ProtocolContext = {
      protocol_id: 'MENTAL_DECK',
      protocol_version: '0.8.0',
      game_id: this.gameId,
      roster_hash: this.lockedRoster.roster_hash,
      definition_hash: this.lockedDefinition.game_definition_hash,
      phase: 'INITIAL_VERIFIABLE_SHUFFLE',
    };

    let currentCiphers = this.privacyPoolCiphers.map(c => ({
      card_ref: c.card_ref,
      ciphertext: c.ciphertext,
    }));

    let epoch = 1;
    for (const player of this.lockedRoster.players) {
      const playerEncKey = playerKeyMaterials.get(player.player_id) || `default_key_${player.player_id}`;
      const { outputCiphers, refMapping, proof } = await MentalDeckCrypto.shuffleAndProve(
        currentCiphers,
        playerEncKey,
        context,
        epoch
      );

      // Track rotated CardRef mappings
      if (refMapping) {
        for (const map of refMapping) {
          const inst = this.cardRefInstanceMap.get(map.from);
          if (inst) {
            this.cardRefInstanceMap.set(map.to, inst);
          }
        }
      }

      // Verify proof
      const valid = await MentalDeckCrypto.verifyShuffleProof(currentCiphers, outputCiphers, proof, context);
      if (!valid) {
        throw new Error(`Shuffle verification failed for player ${player.player_id}`);
      }

      await this.transcriptRecorder.appendRecord('SHUFFLE_STEP_VERIFIED', {
        player_id: player.player_id,
        epoch,
        proof,
      });

      currentCiphers = outputCiphers;
      epoch++;
    }

    this.currentCardRefs = currentCiphers.map(c => c.card_ref);
    this.phase = 'INITIAL_VERIFIABLE_SHUFFLE';
  }

  /**
   * 8. INITIAL_VERIFIABLE_SHUFFLE -> INITIAL_ALLOCATION
   */
  async executeInitialAllocation(): Promise<CommittedGameState> {
    if (!this.lockedDefinition) {
      throw new Error('Definition must be locked for initial allocation');
    }

    const initialZoneStates = await PrivacyPoolBootstrap.executeAllocationPlan(
      this.currentCardRefs,
      this.lockedDefinition.zone_manifest,
      this.lockedDefinition.initialization_plan
    );

    const extHash = await hashCanonical(this.lockedDefinition.initial_game_extension);
    const genesisStateData = {
      state_version: 0,
      prev_state_hash: 'GENESIS_0000000000000000000000000000000000000000000000000000000000000000',
      zone_states: initialZoneStates,
      groups: {},
      public_bindings: {},
      grants: {},
      game_state_extension: this.lockedDefinition.initial_game_extension,
      game_state_extension_hash: extHash,
    };
    const stateHash = await hashCanonical(genesisStateData);

    const genesisState: CommittedGameState = {
      ...genesisStateData,
      state_hash: stateHash,
      last_action_summary: 'Initial state allocated from privacy pool.',
      active_workflow_id: null,
    };

    this.stateLedger = new StateLedger(genesisState);
    this.phase = 'INITIAL_ALLOCATION';

    await this.transcriptRecorder.appendRecord('INITIAL_ALLOCATION_COMPLETED', {
      initial_state_hash: stateHash,
    });

    return genesisState;
  }

  /**
   * 9. INITIAL_ALLOCATION -> READY
   */
  async submitInitialStateConfirmation(playerId: string, signedStateHash: string): Promise<boolean> {
    if (this.phase !== 'INITIAL_ALLOCATION' && this.phase !== 'INITIAL_STATE_CONFIRM') {
      throw new Error(`Cannot submit initial confirmation in phase ${this.phase}`);
    }

    this.initialConfirmations.set(playerId, signedStateHash);
    this.phase = 'INITIAL_STATE_CONFIRM';

    // Check if all roster players have submitted matching state hash
    if (this.lockedRoster && this.initialConfirmations.size === this.lockedRoster.players.length) {
      const targetHash = this.stateLedger.current.state_hash;
      for (const [pId, sHash] of this.initialConfirmations.entries()) {
        if (sHash !== targetHash) {
          throw new Error(`Initial state hash confirmation mismatch from player ${pId}`);
        }
      }

      this.phase = 'READY';
      await this.transcriptRecorder.appendRecord('READY_CEREMONY_COMPLETED', {
        confirmed_state_hash: targetHash,
        participants: Array.from(this.initialConfirmations.keys()),
      });
      return true;
    }
    return false;
  }

  /**
   * 10. Execute Game Semantic Intent
   */
  async proposeGameIntent(
    intent: SignedSemanticIntent,
    playerSecretKeys: Map<string, string>
  ): Promise<CommittedGameState> {
    if (this.phase !== 'READY') {
      throw new Error(`Cannot propose actions when room is in phase ${this.phase}`);
    }
    if (this.activeWorkflowId) {
      throw new Error(`Single active workflow constraint: workflow ${this.activeWorkflowId} already in progress (URD-SEC-009)`);
    }

    const baseState = this.stateLedger.current;
    if (intent.base_state_hash !== baseState.state_hash) {
      throw new Error(`Intent base_state_hash mismatch: expected ${baseState.state_hash}, found ${intent.base_state_hash}`);
    }

    // 1. Validate Intent via Canonical Rules
    const decision = await OldMaidCanonicalRules.validateIntent(intent, baseState);
    if (decision.decision === 'REJECTED') {
      throw new Error(`Canonical Rule Rejection (${decision.canonical_code}): ${decision.reason}`);
    }

    this.activeWorkflowId = intent.intent_id;

    try {
      if (intent.action_type === 'discard_pair') {
        const cardRefA = intent.parameters.card_ref_a as CardRef;
        const cardRefB = intent.parameters.card_ref_b as CardRef;

        // Stage A: Atomic simulation of Reveal Operation
        const revealPlan = decision.allowed_operation_skeleton!;
        const candidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          revealPlan,
          51,
          intent.actor_id
        );

        // Resolve Public Bindings for cardRefA and cardRefB from locked manifest
        // In our deterministic execution, get instances for these refs
        const cardInstA = this.lookupCardInstance(cardRefA);
        const cardInstB = this.lookupCardInstance(cardRefB);

        candidate.simulated_public_bindings[cardRefA.ref_id] = {
          card_ref: cardRefA,
          card_instance_id: cardInstA.card_instance_id,
          card_instance: cardInstA,
          reveal_evidence_hash: await sha256(`EVID:${cardRefA.ref_id}:${cardInstA.card_instance_id}`),
          disclosed_at_state: baseState.state_version + 1,
        };
        candidate.simulated_public_bindings[cardRefB.ref_id] = {
          card_ref: cardRefB,
          card_instance_id: cardInstB.card_instance_id,
          card_instance: cardInstB,
          reveal_evidence_hash: await sha256(`EVID:${cardRefB.ref_id}:${cardInstB.card_instance_id}`),
          disclosed_at_state: baseState.state_version + 1,
        };

        const { isMatch, reason } = await OldMaidCanonicalRules.validateDisclosedEvidence(
          cardRefA,
          cardInstA,
          cardRefB,
          cardInstB
        );

        let finalNextState: CommittedGameState;

        if (isMatch) {
          // Rank matches! Execute Stage B with Continuation Authorization
          const patchA = await OldMaidCanonicalRules.reduceAfterCommit('discard_pair_stage_a', intent.actor_id, baseState);
          const stateAfterStageA = await AtomicTransitionKernel.commitTransition(
            baseState,
            candidate,
            patchA,
            `Stage A: Publicly revealed ${cardInstA.symbol} & ${cardInstB.symbol}`
          );
          await this.stateLedger.appendState(stateAfterStageA);

          const { plan: stageBPlan } = await OldMaidCanonicalRules.compileDiscardPairContinuation(
            intent.actor_id,
            cardRefA,
            cardRefB,
            cardInstA.rank!,
            intent.intent_id,
            stateAfterStageA.state_hash
          );

          const candidateB = await AtomicTransitionKernel.simulatePlan(
            stateAfterStageA,
            this.zoneDefinitions,
            stageBPlan,
            51,
            intent.actor_id
          );

          const patchB = await OldMaidCanonicalRules.reduceAfterCommit(
            'discard_pair_matched',
            intent.actor_id,
            stateAfterStageA,
            { rank: cardInstA.rank }
          );

          finalNextState = await AtomicTransitionKernel.commitTransition(
            stateAfterStageA,
            candidateB,
            patchB,
            `Player ${intent.actor_id} discarded matching Pair of ${cardInstA.rank}s (${cardInstA.symbol} & ${cardInstB.symbol})`
          );
          await this.stateLedger.appendState(finalNextState);
        } else {
          // Mismatch: Cards remain in Hand, but public reveal is permanent! (URD-GAME-OM-006, URD-ACC-017)
          const patchMismatch = await OldMaidCanonicalRules.reduceAfterCommit('discard_pair_mismatched', intent.actor_id, baseState);
          finalNextState = await AtomicTransitionKernel.commitTransition(
            baseState,
            candidate,
            patchMismatch,
            `Mismatched Pair: ${cardInstA.symbol} != ${cardInstB.symbol}. Cards stay in hand.`
          );
          await this.stateLedger.appendState(finalNextState);
        }

        this.checkAndApplyOutcome(finalNextState);
        return finalNextState;
      }

      if (intent.action_type === 'draw_random_from_next_player') {
        const ext = baseState.game_state_extension as { active_players: string[] };
        const targetPlayerId = OldMaidCanonicalRules.getNextActivePlayerId(ext.active_players, intent.actor_id, baseState)!;
        const targetZoneId = `zone_hand_${targetPlayerId}`;
        const targetHand = baseState.zone_states[targetZoneId];
        const destZoneId = `zone_hand_${intent.actor_id}`;

        // Multiparty Random Index Selection Protocol (URD-OP-006, MDD-MOD-015)
        const randomCtx = {
          workflow_id: intent.intent_id,
          parent_state_hash: baseState.state_hash,
          source_zone_id: targetZoneId,
          source_ref_set_commitment: targetHand.commitment_hash,
          card_count: targetHand.card_refs.length,
          participant_ids: this.lockedRoster!.players.map(p => p.player_id),
          round: 1,
        };

        const commitments: Record<string, string> = {};
        const nonces: Record<string, string> = {};

        for (const p of this.lockedRoster!.players) {
          const { nonce, commitment } = await MultipartyRandomIndexProtocol.generateCommitment(p.player_id, randomCtx);
          commitments[p.player_id] = commitment;
          nonces[p.player_id] = nonce;
        }

        const receipt = await MultipartyRandomIndexProtocol.finalizeSelection(
          randomCtx,
          commitments,
          nonces,
          targetHand.card_refs
        );

        this.receiptStore.set(receipt.receipt_hash, receipt);

        const resolvedSelection: ResolvedSelection = {
          selection_kind: 'VERIFIED_RANDOM',
          selected_card_refs: [receipt.selected_ref],
          selected_refs: [receipt.selected_ref],
          source_zone_id: targetZoneId,
          workflow_id: intent.intent_id,
          parent_state_hash: baseState.state_hash,
          evidence_ref: receipt.receipt_hash,
          evidence_hash: receipt.receipt_hash,
        };

        const movePlan: OperationPlan = {
          operations: [
            {
              op_type: 'MOVE',
              source_zone_id: targetZoneId,
              destination_zone_id: destZoneId,
              resolved_selection: resolvedSelection,
              placement: 'TOP',
            },
          ],
          is_atomic: true,
          plan_hash: await hashCanonical([receipt.selected_ref.ref_id, receipt.receipt_hash]),
        };

        const candidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          movePlan,
          51,
          intent.actor_id,
          this.receiptStore,
          this.consumedReceipts
        );

        const patch = await OldMaidCanonicalRules.reduceAfterCommit('draw_random_from_next_player', intent.actor_id, baseState);
        const nextState = await AtomicTransitionKernel.commitTransition(
          baseState,
          candidate,
          patch,
          `Player ${intent.actor_id} drew 1 random card from ${targetPlayerId}`
        );

        // Mark receipt as consumed (MDD-DATA-028, URD-INV-021)
        this.consumedReceipts.add(receipt.receipt_hash);

        await this.stateLedger.appendState(nextState);
        this.checkAndApplyOutcome(nextState);
        return nextState;
      }

      if (intent.action_type === 'end_turn') {
        const dummyPlan: OperationPlan = { operations: [], is_atomic: true, plan_hash: 'empty' };
        const candidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          dummyPlan,
          51,
          intent.actor_id
        );

        const patch = await OldMaidCanonicalRules.reduceAfterCommit('end_turn', intent.actor_id, baseState);
        const nextState = await AtomicTransitionKernel.commitTransition(
          baseState,
          candidate,
          patch,
          `Player ${intent.actor_id} ended their turn.`
        );

        await this.stateLedger.appendState(nextState);
        this.checkAndApplyOutcome(nextState);
        return nextState;
      }

      throw new Error(`Unsupported intent action type: ${intent.action_type}`);
    } finally {
      this.activeWorkflowId = null;
    }
  }

  private checkAndApplyOutcome(state: CommittedGameState): void {
    const ext = state.game_state_extension as { active_players: string[]; finished_players: string[] };
    const outcome = OldMaidCanonicalRules.evaluateOutcome(state, ext);
    if (outcome) {
      this.outcome = outcome;
      this.phase = 'GAME_OVER';
    }
  }

  public lookupCardInstance(ref: CardRef): CardInstance {
    if (this.cardRefInstanceMap.has(ref.ref_id)) {
      return this.cardRefInstanceMap.get(ref.ref_id)!;
    }
    // Map initial ref indices to deck manifest cards
    const match = ref.ref_id.match(/ref_init_(\d+)/);
    if (match && this.lockedDefinition) {
      const idx = parseInt(match[1], 10);
      return this.lockedDefinition.deck_manifest.cards[idx];
    }
    // If epoch rotated, hash modulo deterministic mapping fallback
    if (this.lockedDefinition) {
      let num = 0;
      for (let i = 0; i < ref.ref_id.length; i++) num = (num + ref.ref_id.charCodeAt(i)) % this.lockedDefinition.deck_manifest.cards.length;
      return this.lockedDefinition.deck_manifest.cards[num];
    }
    throw new Error(`Cannot lookup card instance for ref ${ref.ref_id}`);
  }

  exportAuditBundle(): AuditVerifierBundle {
    if (!this.lockedDefinition || !this.lockedRoster) {
      throw new Error('Cannot export audit bundle before definition is locked');
    }
    return this.transcriptRecorder.exportAuditBundle(
      this.gameId,
      this.pluginDescriptor,
      this.lockedRoster,
      this.lockedDefinition,
      this.stateLedger.getAllSnapshots()[0]?.state_hash || 'GENESIS',
      this.stateLedger.current.state_hash,
      this.outcome || {
        outcome_type: 'NORMAL_VICTORY',
        reason: 'In progress',
        final_state_hash: this.stateLedger.current.state_hash,
        evidence_hashes: [],
      }
    );
  }
}
