/**
 * Mental Deck - Game Room Coordinator.
 *
 * Current executable path is a SINGLE-PROCESS SIMULATION harness. Production use is
 * blocked until a real multi-client/WASM Mental Poker provider replaces the simulation
 * crypto/oracle. Security boundaries that can be enforced independently of that provider
 * (signed intents, PoK presence, state/version binding, selection provenance, staged
 * disclosure ordering) fail closed here.
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
  SignedSemanticIntent,
  ZoneDefinition,
  ZoneManifest,
} from '../types/contracts';
import { AtomicTransitionKernel } from '../core/atomicKernel';
import { PrivacyPoolBootstrap } from '../core/privacyPool';
import { StateLedger } from '../core/stateLedger';
import {
  CRYPTO_SECURITY_STATUS,
  hashCanonical,
  MentalDeckCrypto,
  sha256,
} from '../crypto/cryptoProvider';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { OldMaidCanonicalRules } from '../plugins/oldMaid/canonicalRules';
import { OldMaidDefinitionBuilder, OLD_MAID_PLUGIN_DESCRIPTOR } from '../plugins/oldMaid/definition';
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
  public readonly securityMode = CRYPTO_SECURITY_STATUS;
  public phase: RoomPhase = 'ROOM_OPEN';
  public pluginDescriptor!: PluginArtifactDescriptor;
  public publicConfig!: PublicGameConfig;
  public draftPlayers: PlayerIdentity[] = [];
  public lockedRoster?: LockedRoster;
  public lockedDefinition?: LockedGameDefinition;
  public jointPublicKey?: string;
  public privacyPoolCiphers: CipherCard[] = [];
  public currentCardRefs: CardRef[] = [];
  public initialConfirmations = new Map<string, string>();
  public stateLedger!: StateLedger;
  public transcriptRecorder = new TranscriptRecorder();
  public zoneDefinitions: Record<string, ZoneDefinition> = {};
  public outcome: ProtocolOutcome | null = null;
  public activeWorkflowId: string | null = null;
  public receiptStore = new Map<string, RandomSelectionReceipt>();
  public consumedReceipts = new Set<string>();

  /**
   * DEV-ONLY plaintext oracle used solely because the real distributed disclosure
   * provider is not installed yet. It must never be exported through player APIs/audit.
   */
  private simulationCardRefInstanceMap = new Map<string, CardInstance>();

  constructor(public readonly gameId: string) {
    PinnedPluginArtifactHost.registerAllowlistedPlugin(OLD_MAID_PLUGIN_DESCRIPTOR);
  }

  async initializeRoom(
    pluginDescriptor: PluginArtifactDescriptor = OLD_MAID_PLUGIN_DESCRIPTOR,
    config: PublicGameConfig = { min_players: 2, max_players: 6 }
  ): Promise<void> {
    this.pluginDescriptor = PinnedPluginArtifactHost.resolvePlugin(
      pluginDescriptor.plugin_id,
      pluginDescriptor.plugin_version,
      pluginDescriptor.plugin_package_hash
    );
    this.publicConfig = config;
    this.phase = 'PLUGIN_PINNED';
    await this.transcriptRecorder.appendRecord('PLUGIN_PINNED', {
      game_id: this.gameId,
      plugin_id: this.pluginDescriptor.plugin_id,
      plugin_version: this.pluginDescriptor.plugin_version,
      package_hash: this.pluginDescriptor.plugin_package_hash,
      security_mode: this.securityMode,
      config,
    });
  }

  async registerPlayer(player: PlayerIdentity): Promise<void> {
    if (this.phase !== 'PLUGIN_PINNED' && this.phase !== 'PLAYERS_JOINING') {
      throw new Error(`Cannot join players in phase ${this.phase}`);
    }
    if (this.draftPlayers.some(p => p.player_id === player.player_id)) throw new Error(`Player ${player.player_id} already registered`);
    if (this.draftPlayers.length >= this.publicConfig.max_players) throw new Error('Room is full');
    if (!player.signing_public_key || !player.encryption_public_key || !player.pok_proof) {
      throw new Error('Player registration requires signing key, encryption key, and ownership proof');
    }
    this.draftPlayers.push({ ...player });
    this.phase = 'PLAYERS_JOINING';
    await this.transcriptRecorder.appendRecord('PLAYER_REGISTERED', {
      player_id: player.player_id,
      display_name: player.display_name,
      is_ai: player.is_ai,
      signing_pub_key: player.signing_public_key,
      enc_pub_key: player.encryption_public_key,
    });
  }

  async lockRoster(): Promise<LockedRoster> {
    if (this.draftPlayers.length < this.publicConfig.min_players) throw new Error('Not enough players to lock roster');
    const rosterPlayers = this.draftPlayers.map(p => ({ ...p }));
    this.lockedRoster = {
      players: rosterPlayers,
      roster_hash: await hashCanonical(rosterPlayers),
      locked_at: Date.now(),
    };
    this.phase = 'ROSTER_LOCKED';
    await this.transcriptRecorder.appendRecord('ROSTER_LOCKED', {
      roster_hash: this.lockedRoster.roster_hash,
      player_ids: rosterPlayers.map(p => p.player_id),
    });
    return this.lockedRoster;
  }

  async lockDefinition(): Promise<LockedGameDefinition> {
    if (!this.lockedRoster) throw new Error('Roster must be locked before definition');
    if (this.pluginDescriptor.plugin_id !== OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id) {
      throw new Error('Coordinator plugin runtime is not generic yet; fixture must not be reported as end-to-end supported');
    }

    const deckManifest: DeckManifest = await OldMaidDefinitionBuilder.buildDeckManifest();
    const zoneManifest: ZoneManifest = await OldMaidDefinitionBuilder.buildZoneManifest(this.lockedRoster);
    const initialExt = OldMaidDefinitionBuilder.buildInitialGameExtension(this.lockedRoster);
    const initPlan: InitializationPlan = await OldMaidDefinitionBuilder.buildInitializationPlan(this.lockedRoster);
    this.zoneDefinitions = Object.fromEntries(zoneManifest.zones.map(z => [z.zone_id, z]));

    const draft = {
      plugin_descriptor: this.pluginDescriptor,
      roster_hash: this.lockedRoster.roster_hash,
      deck_manifest: deckManifest,
      zone_manifest: zoneManifest,
      initial_game_extension: initialExt,
      initialization_plan: initPlan,
    };
    this.lockedDefinition = { ...draft, game_definition_hash: await hashCanonical(draft) };
    this.phase = 'DEFINITION_LOCKED';
    await this.transcriptRecorder.appendRecord('DEFINITION_LOCKED', {
      game_definition_hash: this.lockedDefinition.game_definition_hash,
      deck_cards_count: deckManifest.cards.length,
      zones_count: zoneManifest.zones.length,
    });
    return this.lockedDefinition;
  }

  async setupCryptoKeys(): Promise<string> {
    if (!this.lockedRoster || !this.lockedDefinition) throw new Error('Definition must be locked before key setup');
    for (const player of this.lockedRoster.players) {
      if (!player.pok_proof) throw new Error(`Missing key ownership proof for player ${player.player_id}`);
      if (!(await MentalDeckCrypto.verifyPoK(player.player_id, player.encryption_public_key, player.pok_proof))) {
        throw new Error(`PoK verification failed for player ${player.player_id}`);
      }
    }
    this.jointPublicKey = await MentalDeckCrypto.deriveJointPublicKey(
      this.lockedRoster.players.map(p => p.encryption_public_key)
    );
    this.phase = 'KEY_SETUP';
    await this.transcriptRecorder.appendRecord('KEY_SETUP_COMPLETED', {
      joint_public_key: this.jointPublicKey,
      security_mode: this.securityMode,
    });
    return this.jointPublicKey;
  }

  async bootstrapPrivacyPool(): Promise<void> {
    if (!this.lockedDefinition || !this.jointPublicKey) throw new Error('Keys must be ready before Privacy Pool bootstrap');
    const { ciphers, initialRefs } = await PrivacyPoolBootstrap.bootstrapPrivacyPool(
      this.lockedDefinition.deck_manifest,
      this.jointPublicKey
    );
    this.privacyPoolCiphers = ciphers;
    this.currentCardRefs = initialRefs;
    this.phase = 'PRIVACY_POOL_READY';

    this.simulationCardRefInstanceMap.clear();
    for (let i = 0; i < initialRefs.length; i++) {
      this.simulationCardRefInstanceMap.set(initialRefs[i].ref_id, this.lockedDefinition.deck_manifest.cards[i]);
    }

    await this.transcriptRecorder.appendRecord('PRIVACY_POOL_BOOTSTRAPPED', {
      total_ciphers: ciphers.length,
      initial_pool_hash: await hashCanonical(ciphers),
      plaintext_oracle_in_transcript: false,
    });
  }

  async executeVerifiableShuffle(playerKeyMaterials: Map<string, string>): Promise<void> {
    if (!this.lockedDefinition || !this.lockedRoster) throw new Error('Missing locked definition/roster for shuffle');
    const context: ProtocolContext = {
      protocol_id: 'MENTAL_DECK',
      protocol_version: '0.9.0',
      game_id: this.gameId,
      roster_hash: this.lockedRoster.roster_hash,
      definition_hash: this.lockedDefinition.game_definition_hash,
      phase: 'INITIAL_VERIFIABLE_SHUFFLE',
    };

    let currentCiphers = this.privacyPoolCiphers.map(c => ({ card_ref: c.card_ref, ciphertext: c.ciphertext }));
    let epoch = 1;
    for (const player of this.lockedRoster.players) {
      const simulationSecret = playerKeyMaterials.get(player.player_id);
      if (!simulationSecret) throw new Error(`Simulation shuffle missing local contribution for ${player.player_id}`);
      const { outputCiphers, refMapping, proof } = await MentalDeckCrypto.shuffleAndProve(
        currentCiphers,
        simulationSecret,
        context,
        epoch
      );
      if (!(await MentalDeckCrypto.verifyShuffleProof(currentCiphers, outputCiphers, proof, context))) {
        throw new Error(`Shuffle transcript verification failed for ${player.player_id}`);
      }

      // DEV-ONLY oracle follows ref rotation; this path is blocked from production.
      for (const mapping of refMapping ?? []) {
        const instance = this.simulationCardRefInstanceMap.get(mapping.from);
        if (instance) {
          this.simulationCardRefInstanceMap.delete(mapping.from);
          this.simulationCardRefInstanceMap.set(mapping.to, instance);
        }
      }
      await this.transcriptRecorder.appendRecord('SHUFFLE_STEP_VERIFIED', {
        player_id: player.player_id,
        epoch,
        proof,
        security_mode: this.securityMode,
      });
      currentCiphers = outputCiphers;
      epoch++;
    }
    this.currentCardRefs = currentCiphers.map(c => c.card_ref);
    this.phase = 'INITIAL_VERIFIABLE_SHUFFLE';
  }

  async executeInitialAllocation(): Promise<CommittedGameState> {
    if (!this.lockedDefinition) throw new Error('Definition must be locked for initial allocation');
    const initialZoneStates = await PrivacyPoolBootstrap.executeAllocationPlan(
      this.currentCardRefs,
      this.lockedDefinition.zone_manifest,
      this.lockedDefinition.initialization_plan
    );
    const extHash = await hashCanonical(this.lockedDefinition.initial_game_extension);
    const genesisData = {
      state_version: 0,
      prev_state_hash: 'GENESIS_0000000000000000000000000000000000000000000000000000000000000000',
      zone_states: initialZoneStates,
      groups: {},
      public_bindings: {},
      grants: {},
      game_state_extension: this.lockedDefinition.initial_game_extension,
      game_state_extension_hash: extHash,
    };
    const genesis: CommittedGameState = {
      ...genesisData,
      state_hash: await hashCanonical(genesisData),
      last_action_summary: 'Initial state allocated from Privacy Pool',
      active_workflow_id: null,
    };
    this.stateLedger = new StateLedger(genesis);
    this.phase = 'INITIAL_ALLOCATION';
    await this.transcriptRecorder.appendRecord('INITIAL_ALLOCATION_COMPLETED', { initial_state_hash: genesis.state_hash });
    return genesis;
  }

  async submitInitialStateConfirmation(
    playerId: string,
    stateHash: string,
    signature: string
  ): Promise<boolean> {
    if (this.phase !== 'INITIAL_ALLOCATION' && this.phase !== 'INITIAL_STATE_CONFIRM') {
      throw new Error(`Cannot submit initial confirmation in phase ${this.phase}`);
    }
    if (!this.lockedRoster) throw new Error('Roster missing');
    const player = this.lockedRoster.players.find(p => p.player_id === playerId);
    if (!player) throw new Error(`Unknown roster player ${playerId}`);
    const targetHash = this.stateLedger.current.state_hash;
    if (stateHash !== targetHash) throw new Error('Initial state hash confirmation mismatch');
    const payload = { game_id: this.gameId, player_id: playerId, state_hash: stateHash, purpose: 'INITIAL_STATE_CONFIRM' };
    if (!(await MentalDeckCrypto.verifySemanticIntent(player.signing_public_key, signature, payload))) {
      throw new Error(`Invalid initial state confirmation signature for ${playerId}`);
    }
    if (this.initialConfirmations.has(playerId)) throw new Error(`Duplicate initial confirmation from ${playerId}`);
    this.initialConfirmations.set(playerId, signature);
    this.phase = 'INITIAL_STATE_CONFIRM';

    if (this.initialConfirmations.size === this.lockedRoster.players.length) {
      this.phase = 'READY';
      await this.transcriptRecorder.appendRecord('READY_CEREMONY_COMPLETED', {
        confirmed_state_hash: targetHash,
        participants: [...this.initialConfirmations.keys()],
      });
      return true;
    }
    return false;
  }

  private async verifyIntent(intent: SignedSemanticIntent, baseState: CommittedGameState): Promise<PlayerIdentity> {
    if (!this.lockedRoster || !this.lockedDefinition) throw new Error('Game not initialized');
    if (intent.plugin_id !== this.pluginDescriptor.plugin_id) throw new Error('Intent plugin_id does not match pinned plugin');
    if (intent.base_state_hash !== baseState.state_hash || intent.base_state_version !== baseState.state_version) {
      throw new Error('Intent base state/version mismatch');
    }
    const player = this.lockedRoster.players.find(p => p.player_id === intent.actor_id);
    if (!player) throw new Error(`Intent actor ${intent.actor_id} is not in locked roster`);
    const { signature, ...unsigned } = intent;
    if (!(await MentalDeckCrypto.verifySemanticIntent(player.signing_public_key, signature, unsigned))) {
      throw new Error(`Invalid semantic intent signature for ${intent.actor_id}`);
    }
    return player;
  }

  async proposeGameIntent(
    intent: SignedSemanticIntent,
    simulationPlayerSecrets: Map<string, string>
  ): Promise<CommittedGameState> {
    if (this.phase !== 'READY') throw new Error(`Cannot propose actions in phase ${this.phase}`);
    if (this.activeWorkflowId) throw new Error(`Workflow ${this.activeWorkflowId} already active`);
    const baseState = this.stateLedger.current;
    await this.verifyIntent(intent, baseState);

    const decision = await OldMaidCanonicalRules.validateIntent(intent, baseState);
    if (decision.decision === 'REJECTED') {
      throw new Error(`Canonical Rule Rejection (${decision.canonical_code}): ${decision.reason}`);
    }

    this.activeWorkflowId = intent.intent_id;
    try {
      if (intent.action_type === 'discard_pair') {
        const a = intent.parameters.card_ref_a as CardRef;
        const b = intent.parameters.card_ref_b as CardRef;
        const revealCandidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          decision.allowed_operation_skeleton!,
          this.lockedDefinition!.deck_manifest.cards.length,
          intent.actor_id
        );

        // Stage A commits disclosure authorization BEFORE any plaintext is consulted.
        const patchA = await OldMaidCanonicalRules.reduceAfterCommit('discard_pair_stage_a', intent.actor_id, baseState);
        const stateAfterStageA = await AtomicTransitionKernel.commitTransition(
          baseState,
          revealCandidate,
          patchA,
          'Stage A: public disclosure authorized; waiting for shares'
        );
        await this.stateLedger.appendState(stateAfterStageA);

        // Simulation-only stand-in for distributed partial decrypt + DLEQ verification.
        const cardA = this.simulationLookupCardInstance(a);
        const cardB = this.simulationLookupCardInstance(b);
        const disclosureCandidate = await AtomicTransitionKernel.simulatePlan(
          stateAfterStageA,
          this.zoneDefinitions,
          { operations: [], is_atomic: true, plan_hash: await hashCanonical(['disclosure_bind', a, b]) },
          this.lockedDefinition!.deck_manifest.cards.length,
          intent.actor_id
        );
        disclosureCandidate.simulated_public_bindings[a.ref_id] = {
          card_ref: a,
          card_instance_id: cardA.card_instance_id,
          card_instance: cardA,
          reveal_evidence_hash: await sha256(`SIM_DISCLOSURE:${a.ref_id}:${cardA.card_instance_id}:${stateAfterStageA.state_hash}`),
          disclosed_at_state: stateAfterStageA.state_version + 1,
        };
        disclosureCandidate.simulated_public_bindings[b.ref_id] = {
          card_ref: b,
          card_instance_id: cardB.card_instance_id,
          card_instance: cardB,
          reveal_evidence_hash: await sha256(`SIM_DISCLOSURE:${b.ref_id}:${cardB.card_instance_id}:${stateAfterStageA.state_hash}`),
          disclosed_at_state: stateAfterStageA.state_version + 1,
        };
        const disclosurePatch = {
          next_game_state_extension: stateAfterStageA.game_state_extension,
          next_extension_hash: await hashCanonical(stateAfterStageA.game_state_extension),
        };
        const stateAfterDisclosure = await AtomicTransitionKernel.commitTransition(
          stateAfterStageA,
          disclosureCandidate,
          disclosurePatch,
          'Disclosure evidence published (simulation provider)'
        );
        await this.stateLedger.appendState(stateAfterDisclosure);

        const { isMatch } = await OldMaidCanonicalRules.validateDisclosedEvidence(a, cardA, b, cardB);
        if (!isMatch) {
          const mismatchPatch = await OldMaidCanonicalRules.reduceAfterCommit('discard_pair_mismatched', intent.actor_id, stateAfterDisclosure);
          const mismatchCandidate = await AtomicTransitionKernel.simulatePlan(
            stateAfterDisclosure,
            this.zoneDefinitions,
            { operations: [], is_atomic: true, plan_hash: 'mismatch_no_move' },
            this.lockedDefinition!.deck_manifest.cards.length,
            intent.actor_id
          );
          const mismatchState = await AtomicTransitionKernel.commitTransition(
            stateAfterDisclosure,
            mismatchCandidate,
            mismatchPatch,
            'Mismatched pair: cards remain in hand and stay public-known'
          );
          await this.stateLedger.appendState(mismatchState);
          return mismatchState;
        }

        const { plan } = await OldMaidCanonicalRules.compileDiscardPairContinuation(
          intent.actor_id,
          a,
          b,
          cardA.rank!,
          intent.intent_id,
          stateAfterDisclosure.state_hash
        );
        const candidateB = await AtomicTransitionKernel.simulatePlan(
          stateAfterDisclosure,
          this.zoneDefinitions,
          plan,
          this.lockedDefinition!.deck_manifest.cards.length,
          intent.actor_id
        );
        const patchB = await OldMaidCanonicalRules.reduceAfterCommit(
          'discard_pair_matched', intent.actor_id, stateAfterDisclosure, { rank: cardA.rank }
        );
        const next = await AtomicTransitionKernel.commitTransition(
          stateAfterDisclosure,
          candidateB,
          patchB,
          `Player ${intent.actor_id} discarded a verified pair of ${cardA.rank}s`
        );
        await this.stateLedger.appendState(next);
        this.checkAndApplyOutcome(next);
        return next;
      }

      if (intent.action_type === 'draw_random_from_next_player') {
        const ext = baseState.game_state_extension as { active_players: string[] };
        const targetPlayerId = OldMaidCanonicalRules.getNextActivePlayerId(ext.active_players, intent.actor_id, baseState);
        if (!targetPlayerId) throw new Error('No valid random-draw target');
        const targetZoneId = `zone_hand_${targetPlayerId}`;
        const targetHand = baseState.zone_states[targetZoneId];
        const randomCtx = {
          workflow_id: intent.intent_id,
          parent_state_hash: baseState.state_hash,
          source_zone_id: targetZoneId,
          source_ref_set_commitment: targetHand.commitment_hash,
          card_count: targetHand.card_refs.length,
          participant_ids: this.lockedRoster!.players.map(p => p.player_id),
          round: 1,
        };

        // DEV HARNESS ONLY: each contribution is generated in-process. Production must
        // receive commitments/reveals from distinct authenticated clients.
        const commitments: Record<string, string> = {};
        const nonces: Record<string, string> = {};
        for (const p of this.lockedRoster!.players) {
          if (!simulationPlayerSecrets.has(p.player_id)) {
            throw new Error(`Simulation random round missing participant ${p.player_id}`);
          }
          const contribution = await MultipartyRandomIndexProtocol.generateCommitment(p.player_id, randomCtx);
          commitments[p.player_id] = contribution.commitment;
          nonces[p.player_id] = contribution.nonce;
        }

        const { receipt, resolved_selection } = await MultipartyRandomIndexProtocol.finalizeSelectionWithProvenance(
          randomCtx,
          commitments,
          nonces,
          targetHand.card_refs
        );
        if (this.receiptStore.has(receipt.receipt_hash)) throw new Error('Duplicate random receipt');
        this.receiptStore.set(receipt.receipt_hash, receipt);

        const movePlan: OperationPlan = {
          operations: [{
            op_type: 'MOVE',
            source_zone_id: targetZoneId,
            destination_zone_id: `zone_hand_${intent.actor_id}`,
            resolved_selection,
            placement: 'TOP',
          }],
          is_atomic: true,
          plan_hash: await hashCanonical([resolved_selection, receipt.receipt_hash]),
        };
        const candidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          movePlan,
          this.lockedDefinition!.deck_manifest.cards.length,
          intent.actor_id,
          this.receiptStore,
          this.consumedReceipts
        );
        const patch = await OldMaidCanonicalRules.reduceAfterCommit('draw_random_from_next_player', intent.actor_id, baseState);
        const next = await AtomicTransitionKernel.commitTransition(
          baseState,
          candidate,
          patch,
          `Player ${intent.actor_id} drew one verified-random card from ${targetPlayerId}`
        );
        await this.stateLedger.appendState(next);
        this.consumedReceipts.add(receipt.receipt_hash);
        this.checkAndApplyOutcome(next);
        return next;
      }

      if (intent.action_type === 'end_turn') {
        const candidate = await AtomicTransitionKernel.simulatePlan(
          baseState,
          this.zoneDefinitions,
          { operations: [], is_atomic: true, plan_hash: 'empty' },
          this.lockedDefinition!.deck_manifest.cards.length,
          intent.actor_id
        );
        const patch = await OldMaidCanonicalRules.reduceAfterCommit('end_turn', intent.actor_id, baseState);
        const next = await AtomicTransitionKernel.commitTransition(baseState, candidate, patch, `Player ${intent.actor_id} ended turn`);
        await this.stateLedger.appendState(next);
        this.checkAndApplyOutcome(next);
        return next;
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

  /** DEV ONLY: never expose through a production network API. */
  simulationLookupCardInstance(ref: CardRef): CardInstance {
    const instance = this.simulationCardRefInstanceMap.get(ref.ref_id);
    if (!instance) throw new Error(`Simulation plaintext oracle has no mapping for ${ref.ref_id}`);
    return instance;
  }

  /** @deprecated DEV-only compatibility alias. */
  lookupCardInstance(ref: CardRef): CardInstance {
    return this.simulationLookupCardInstance(ref);
  }

  exportAuditBundle(): AuditVerifierBundle {
    if (!this.lockedDefinition || !this.lockedRoster || !this.stateLedger) {
      throw new Error('Cannot export audit bundle before initialized state exists');
    }
    return this.transcriptRecorder.exportAuditBundle(
      this.gameId,
      this.pluginDescriptor,
      this.lockedRoster,
      this.lockedDefinition,
      this.stateLedger.getAllSnapshots()[0]?.state_hash || 'GENESIS',
      this.stateLedger.current.state_hash,
      this.outcome || {
        outcome_type: 'GAME_STALLED',
        reason: 'Game still in progress; no final outcome',
        final_state_hash: this.stateLedger.current.state_hash,
        evidence_hashes: [],
      }
    );
  }
}
