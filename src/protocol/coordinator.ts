/**
 * Mental Deck - Game Room Coordinator
 *
 * Threat model for this implementation: trusted single-process coordinator.
 * Player semantic intents are nevertheless authenticated with ECDSA so actor
 * spoofing cannot bypass canonical rules. The shuffle/encryption layer remains a
 * documented prototype and is not a production zero-knowledge mental-poker stack.
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
  public initialConfirmations: Map<string, string> = new Map();
  public stateLedger!: StateLedger;
  public transcriptRecorder = new TranscriptRecorder();
  public zoneDefinitions: Record<string, ZoneDefinition> = {};
  public outcome: ProtocolOutcome | null = null;
  public activeWorkflowId: string | null = null;
  public receiptStore: Map<string, RandomSelectionReceipt> = new Map();
  public consumedReceipts: Set<string> = new Set();

  // Trusted-coordinator prototype only. Production mental poker must not retain
  // a global CardRef -> plaintext mapping in one authority.
  private cardRefInstanceMap: Map<string, CardInstance> = new Map();

  constructor(public readonly gameId: string) {
    PinnedPluginArtifactHost.registerAllowlistedPlugin(
      OLD_MAID_PLUGIN_DESCRIPTOR
    );
  }

  private assertPhase(...allowed: RoomPhase[]): void {
    if (!allowed.includes(this.phase)) {
      throw new Error(
        `Operation not allowed in phase ${this.phase}; expected ${allowed.join(' or ')}`
      );
    }
  }

  private get expectedTotalN(): number {
    if (!this.lockedDefinition) {
      throw new Error('Locked definition is required to determine deck size.');
    }
    return this.lockedDefinition.deck_manifest.cards.length;
  }

  async initializeRoom(
    pluginDescriptor: PluginArtifactDescriptor = OLD_MAID_PLUGIN_DESCRIPTOR,
    config: PublicGameConfig = { min_players: 2, max_players: 6 }
  ): Promise<void> {
    this.assertPhase('ROOM_OPEN');
    if (
      !Number.isInteger(config.min_players) ||
      !Number.isInteger(config.max_players) ||
      config.min_players < 2 ||
      config.max_players < config.min_players
    ) {
      throw new Error('Invalid public game configuration.');
    }

    const verified = PinnedPluginArtifactHost.resolvePlugin(
      pluginDescriptor.plugin_id,
      pluginDescriptor.plugin_version,
      pluginDescriptor.plugin_package_hash
    );
    this.pluginDescriptor = verified;
    this.publicConfig = { ...config };
    this.phase = 'PLUGIN_PINNED';

    await this.transcriptRecorder.appendRecord('PLUGIN_PINNED', {
      game_id: this.gameId,
      plugin_id: verified.plugin_id,
      plugin_version: verified.plugin_version,
      package_hash: verified.plugin_package_hash,
      config,
    });
  }

  async registerPlayer(player: PlayerIdentity): Promise<void> {
    this.assertPhase('PLUGIN_PINNED', 'PLAYERS_JOINING');
    if (!player.player_id || !player.signing_public_key || !player.encryption_public_key) {
      throw new Error('Player identity is missing required id/public keys.');
    }
    if (this.draftPlayers.some(existing => existing.player_id === player.player_id)) {
      throw new Error(`Player ${player.player_id} already registered`);
    }
    if (this.draftPlayers.length >= this.publicConfig.max_players) {
      throw new Error(
        `Room full: maximum ${this.publicConfig.max_players} players allowed`
      );
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
    this.assertPhase('PLAYERS_JOINING');
    if (this.draftPlayers.length < this.publicConfig.min_players) {
      throw new Error(
        `Need at least ${this.publicConfig.min_players} players to lock roster. Currently have ${this.draftPlayers.length}.`
      );
    }

    const players = this.draftPlayers.map(player => ({ ...player }));
    const rosterHash = await hashCanonical(players);
    this.lockedRoster = {
      players,
      roster_hash: rosterHash,
      locked_at: Date.now(),
    };
    this.phase = 'ROSTER_LOCKED';

    await this.transcriptRecorder.appendRecord('ROSTER_LOCKED', {
      roster_hash: rosterHash,
      player_ids: players.map(player => player.player_id),
    });
    return this.lockedRoster;
  }

  async lockDefinition(): Promise<LockedGameDefinition> {
    this.assertPhase('ROSTER_LOCKED');
    if (!this.lockedRoster) {
      throw new Error('Roster must be locked before definition.');
    }

    let deckManifest: DeckManifest;
    let zoneManifest: ZoneManifest;
    let initialExt: Record<string, unknown>;
    let initPlan: InitializationPlan;

    if (this.pluginDescriptor.plugin_id === OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id) {
      deckManifest = await OldMaidDefinitionBuilder.buildDeckManifest();
      zoneManifest = await OldMaidDefinitionBuilder.buildZoneManifest(
        this.lockedRoster
      );
      initialExt = OldMaidDefinitionBuilder.buildInitialGameExtension(
        this.lockedRoster
      );
      initPlan = await OldMaidDefinitionBuilder.buildInitializationPlan(
        this.lockedRoster
      );
    } else {
      throw new Error(
        `Unsupported plugin definition builder: ${this.pluginDescriptor.plugin_id}`
      );
    }

    this.zoneDefinitions = {};
    for (const zone of zoneManifest.zones) {
      this.zoneDefinitions[zone.zone_id] = { ...zone };
    }

    const definitionDraft = {
      plugin_descriptor: this.pluginDescriptor,
      roster_hash: this.lockedRoster.roster_hash,
      deck_manifest: deckManifest,
      zone_manifest: zoneManifest,
      initial_game_extension: initialExt,
      initialization_plan: initPlan,
    };
    const definitionHash = await hashCanonical(definitionDraft);
    this.lockedDefinition = {
      ...definitionDraft,
      game_definition_hash: definitionHash,
    };
    this.phase = 'DEFINITION_LOCKED';

    await this.transcriptRecorder.appendRecord('DEFINITION_LOCKED', {
      game_definition_hash: definitionHash,
      deck_cards_count: deckManifest.cards.length,
      zones_count: zoneManifest.zones.length,
    });
    return this.lockedDefinition;
  }

  async setupCryptoKeys(): Promise<string> {
    this.assertPhase('DEFINITION_LOCKED');
    if (!this.lockedRoster || !this.lockedDefinition) {
      throw new Error('Definition and roster are required for key setup.');
    }

    for (const player of this.lockedRoster.players) {
      if (!player.pok_proof) {
        throw new Error(`Missing proof-of-possession for player ${player.player_id}`);
      }
      const valid = await MentalDeckCrypto.verifyPoK(
        player.player_id,
        player.encryption_public_key,
        player.pok_proof
      );
      if (!valid) {
        throw new Error(`PoK verification failed for player ${player.player_id}`);
      }
    }

    const publicKeys = this.lockedRoster.players.map(
      player => player.encryption_public_key
    );
    this.jointPublicKey = await MentalDeckCrypto.deriveJointPublicKey(publicKeys);
    this.phase = 'KEY_SETUP';
    await this.transcriptRecorder.appendRecord('KEY_SETUP_COMPLETED', {
      joint_public_key_commitment: this.jointPublicKey,
      security_model: 'TRUSTED_COORDINATOR_PROTOTYPE',
    });
    return this.jointPublicKey;
  }

  async bootstrapPrivacyPool(): Promise<void> {
    this.assertPhase('KEY_SETUP');
    if (!this.lockedDefinition || !this.jointPublicKey) {
      throw new Error('Keys and definition are required before privacy pool bootstrap.');
    }

    const { ciphers, initialRefs } =
      await PrivacyPoolBootstrap.bootstrapPrivacyPool(
        this.lockedDefinition.deck_manifest,
        this.jointPublicKey
      );

    this.privacyPoolCiphers = ciphers;
    this.currentCardRefs = initialRefs;
    this.cardRefInstanceMap.clear();
    for (let i = 0; i < initialRefs.length; i++) {
      this.cardRefInstanceMap.set(
        initialRefs[i].ref_id,
        this.lockedDefinition.deck_manifest.cards[i]
      );
    }

    this.phase = 'PRIVACY_POOL_READY';
    await this.transcriptRecorder.appendRecord('PRIVACY_POOL_BOOTSTRAPPED', {
      total_ciphers: ciphers.length,
      initial_pool_hash: await hashCanonical(ciphers),
      security_model: 'SIMULATED_JOINT_ENCRYPTION',
    });
  }

  async executeVerifiableShuffle(
    playerKeyMaterials: Map<string, string>
  ): Promise<void> {
    this.assertPhase('PRIVACY_POOL_READY');
    if (!this.lockedDefinition || !this.lockedRoster) {
      throw new Error('Missing definition or roster for shuffle.');
    }

    const context: ProtocolContext = {
      protocol_id: 'MENTAL_DECK',
      protocol_version: '0.9.0-prototype',
      game_id: this.gameId,
      roster_hash: this.lockedRoster.roster_hash,
      definition_hash: this.lockedDefinition.game_definition_hash,
      phase: 'INITIAL_VERIFIABLE_SHUFFLE',
    };

    let currentCiphers = this.privacyPoolCiphers.map(cipher => ({
      card_ref: cipher.card_ref,
      ciphertext: cipher.ciphertext,
    }));

    let epoch = 1;
    for (const player of this.lockedRoster.players) {
      const playerKey = playerKeyMaterials.get(player.player_id);
      if (!playerKey) {
        this.phase = 'GAME_STALLED';
        throw new Error(
          `Missing shuffle contribution for player ${player.player_id}; protocol stalls instead of using a default key.`
        );
      }

      const { outputCiphers, refMapping, proof } =
        await MentalDeckCrypto.shuffleAndProve(
          currentCiphers,
          playerKey,
          context,
          epoch
        );

      const valid = await MentalDeckCrypto.verifyShuffleProof(
        currentCiphers,
        outputCiphers,
        proof,
        context
      );
      if (!valid) {
        this.phase = 'GAME_STALLED';
        throw new Error(
          `Prototype shuffle receipt verification failed for player ${player.player_id}`
        );
      }

      if (refMapping) {
        for (const mapping of refMapping) {
          const cardInstance = this.cardRefInstanceMap.get(mapping.from);
          if (!cardInstance) {
            throw new Error(
              `CardRef mapping ${mapping.from} has no trusted-coordinator plaintext mapping.`
            );
          }
          this.cardRefInstanceMap.set(mapping.to, cardInstance);
          this.cardRefInstanceMap.delete(mapping.from);
        }
      }

      await this.transcriptRecorder.appendRecord('SHUFFLE_STEP_VERIFIED', {
        player_id: player.player_id,
        epoch,
        proof,
        verification_scope: 'prototype integrity receipt; not zero-knowledge proof',
      });

      currentCiphers = outputCiphers;
      epoch += 1;
    }

    this.currentCardRefs = currentCiphers.map(cipher => cipher.card_ref);
    this.phase = 'INITIAL_VERIFIABLE_SHUFFLE';
  }

  async executeInitialAllocation(): Promise<CommittedGameState> {
    this.assertPhase('INITIAL_VERIFIABLE_SHUFFLE');
    if (!this.lockedDefinition) {
      throw new Error('Definition is required for initial allocation.');
    }

    const initialZoneStates =
      await PrivacyPoolBootstrap.executeAllocationPlan(
        this.currentCardRefs,
        this.lockedDefinition.zone_manifest,
        this.lockedDefinition.initialization_plan
      );

    const extensionHash = await hashCanonical(
      this.lockedDefinition.initial_game_extension
    );
    const genesisStateData = {
      state_version: 0,
      prev_state_hash:
        'GENESIS_0000000000000000000000000000000000000000000000000000000000000000',
      zone_states: initialZoneStates,
      groups: {},
      public_bindings: {},
      grants: {},
      game_state_extension: this.lockedDefinition.initial_game_extension,
      game_state_extension_hash: extensionHash,
    };
    const stateHash = await hashCanonical(genesisStateData);
    const genesisState: CommittedGameState = {
      ...genesisStateData,
      state_hash: stateHash,
      last_action_summary: 'Initial state allocated from prototype privacy pool.',
      active_workflow_id: null,
    };

    await StateLedger.assertStateIntegrity(genesisState);
    this.stateLedger = new StateLedger(genesisState);
    this.phase = 'INITIAL_ALLOCATION';
    await this.transcriptRecorder.appendRecord('INITIAL_ALLOCATION_COMPLETED', {
      initial_state_hash: stateHash,
    });
    return genesisState;
  }

  /**
   * Local trusted-coordinator readiness ceremony.
   *
   * This method is not a network authentication boundary; semantic actions use
   * ECDSA authentication later. We nevertheless require exact roster membership
   * and exact state-hash agreement so fake IDs cannot satisfy the quorum.
   */
  async submitInitialStateConfirmation(
    playerId: string,
    confirmedStateHash: string
  ): Promise<boolean> {
    this.assertPhase('INITIAL_ALLOCATION', 'INITIAL_STATE_CONFIRM');
    if (!this.lockedRoster) {
      throw new Error('Roster is required for state confirmation.');
    }
    const rosterPlayer = this.lockedRoster.players.find(
      player => player.player_id === playerId
    );
    if (!rosterPlayer) {
      throw new Error(`Player ${playerId} is not a member of the locked roster.`);
    }

    const targetHash = this.stateLedger.current.state_hash;
    if (confirmedStateHash !== targetHash) {
      throw new Error(
        `Initial state confirmation mismatch from player ${playerId}`
      );
    }

    const previous = this.initialConfirmations.get(playerId);
    if (previous && previous !== confirmedStateHash) {
      throw new Error(`Player ${playerId} attempted conflicting confirmations.`);
    }
    this.initialConfirmations.set(playerId, confirmedStateHash);
    this.phase = 'INITIAL_STATE_CONFIRM';

    await this.transcriptRecorder.appendRecord('INITIAL_STATE_CONFIRMED', {
      player_id: playerId,
      state_hash: confirmedStateHash,
    });

    const allConfirmed = this.lockedRoster.players.every(
      player => this.initialConfirmations.get(player.player_id) === targetHash
    );
    if (!allConfirmed) return false;

    this.phase = 'READY';
    await this.transcriptRecorder.appendRecord('READY_CEREMONY_COMPLETED', {
      confirmed_state_hash: targetHash,
      participants: this.lockedRoster.players.map(player => player.player_id),
    });
    return true;
  }

  private async authenticateIntent(
    intent: SignedSemanticIntent,
    baseState: CommittedGameState
  ): Promise<void> {
    if (!this.lockedRoster || !this.lockedDefinition) {
      throw new Error('Roster and definition must be locked before intents.');
    }
    if (intent.plugin_id !== this.pluginDescriptor.plugin_id) {
      throw new Error(
        `Intent plugin mismatch: expected ${this.pluginDescriptor.plugin_id}, got ${intent.plugin_id}`
      );
    }
    if (intent.base_state_hash !== baseState.state_hash) {
      throw new Error(
        `Intent base_state_hash mismatch: expected ${baseState.state_hash}, found ${intent.base_state_hash}`
      );
    }
    if (intent.base_state_version !== baseState.state_version) {
      throw new Error(
        `Intent base_state_version mismatch: expected ${baseState.state_version}, found ${intent.base_state_version}`
      );
    }

    const actor = this.lockedRoster.players.find(
      player => player.player_id === intent.actor_id
    );
    if (!actor) {
      throw new Error(`Intent actor ${intent.actor_id} is not in the locked roster.`);
    }

    const signatureValid = await MentalDeckCrypto.verifyIntentSignature(
      actor.signing_public_key,
      intent
    );
    if (!signatureValid) {
      throw new Error(`Invalid semantic intent signature for actor ${intent.actor_id}`);
    }
  }

  private async appendCommittedStateRecord(
    state: CommittedGameState,
    intent: SignedSemanticIntent,
    stage: string
  ): Promise<void> {
    await this.transcriptRecorder.appendRecord('STATE_COMMITTED', {
      intent_id: intent.intent_id,
      actor_id: intent.actor_id,
      action_type: intent.action_type,
      stage,
      state_version: state.state_version,
      state_hash: state.state_hash,
      prev_state_hash: state.prev_state_hash,
    });
  }

  async proposeGameIntent(
    intent: SignedSemanticIntent,
    _playerSecretKeys: Map<string, string>
  ): Promise<CommittedGameState> {
    this.assertPhase('READY');
    if (this.activeWorkflowId) {
      throw new Error(
        `Single active workflow constraint: workflow ${this.activeWorkflowId} already in progress`
      );
    }

    const baseState = this.stateLedger.current;
    await this.authenticateIntent(intent, baseState);

    const decision = await OldMaidCanonicalRules.validateIntent(
      intent,
      baseState
    );
    if (decision.decision === 'REJECTED') {
      throw new Error(
        `Canonical Rule Rejection (${decision.canonical_code}): ${decision.reason}`
      );
    }

    await this.transcriptRecorder.appendRecord('SEMANTIC_INTENT_AUTHENTICATED', {
      intent_id: intent.intent_id,
      actor_id: intent.actor_id,
      plugin_id: intent.plugin_id,
      action_type: intent.action_type,
      base_state_hash: intent.base_state_hash,
      base_state_version: intent.base_state_version,
      signature: intent.signature,
    });

    this.activeWorkflowId = intent.intent_id;
    try {
      if (intent.action_type === 'discard_pair') {
        return await this.executeDiscardPairIntent(intent, baseState, decision.allowed_operation_skeleton!);
      }
      if (intent.action_type === 'draw_random_from_next_player') {
        return await this.executeRandomDrawIntent(intent, baseState);
      }
      if (intent.action_type === 'end_turn') {
        return await this.executeEndTurnIntent(intent, baseState);
      }
      throw new Error(`Unsupported intent action type: ${intent.action_type}`);
    } finally {
      this.activeWorkflowId = null;
    }
  }

  private async executeDiscardPairIntent(
    intent: SignedSemanticIntent,
    baseState: CommittedGameState,
    revealPlan: OperationPlan
  ): Promise<CommittedGameState> {
    const cardRefA = intent.parameters.card_ref_a as CardRef;
    const cardRefB = intent.parameters.card_ref_b as CardRef;

    let candidate = await AtomicTransitionKernel.simulatePlan(
      baseState,
      this.zoneDefinitions,
      revealPlan,
      this.expectedTotalN,
      intent.actor_id
    );

    const cardInstA = this.lookupCardInstance(cardRefA);
    const cardInstB = this.lookupCardInstance(cardRefB);
    candidate.simulated_public_bindings[cardRefA.ref_id] = {
      card_ref: cardRefA,
      card_instance_id: cardInstA.card_instance_id,
      card_instance: cardInstA,
      reveal_evidence_hash: await sha256(
        `EVID_V1:${cardRefA.ref_id}:${cardInstA.card_instance_id}:${baseState.state_hash}`
      ),
      disclosed_at_state: baseState.state_version + 1,
    };
    candidate.simulated_public_bindings[cardRefB.ref_id] = {
      card_ref: cardRefB,
      card_instance_id: cardInstB.card_instance_id,
      card_instance: cardInstB,
      reveal_evidence_hash: await sha256(
        `EVID_V1:${cardRefB.ref_id}:${cardInstB.card_instance_id}:${baseState.state_hash}`
      ),
      disclosed_at_state: baseState.state_version + 1,
    };
    await AtomicTransitionKernel.resealCandidate(candidate);

    const { isMatch } = await OldMaidCanonicalRules.validateDisclosedEvidence(
      cardRefA,
      cardInstA,
      cardRefB,
      cardInstB
    );

    const projectedStageA = AtomicTransitionKernel.projectCandidateState(
      baseState,
      candidate
    );

    if (!isMatch) {
      const patchMismatch = await OldMaidCanonicalRules.reduceAfterCommit(
        'discard_pair_mismatched',
        intent.actor_id,
        projectedStageA
      );
      const mismatchState = await AtomicTransitionKernel.commitTransition(
        baseState,
        candidate,
        patchMismatch,
        `Mismatched Pair: ${cardInstA.symbol} != ${cardInstB.symbol}. Cards stay in hand.`
      );
      await this.stateLedger.appendState(mismatchState);
      await this.appendCommittedStateRecord(mismatchState, intent, 'discard_pair_mismatch');
      this.checkAndApplyOutcome(mismatchState);
      return mismatchState;
    }

    const patchA = await OldMaidCanonicalRules.reduceAfterCommit(
      'discard_pair_stage_a',
      intent.actor_id,
      projectedStageA
    );
    const stateAfterStageA = await AtomicTransitionKernel.commitTransition(
      baseState,
      candidate,
      patchA,
      `Stage A: Publicly revealed ${cardInstA.symbol} & ${cardInstB.symbol}`
    );
    await this.stateLedger.appendState(stateAfterStageA);
    await this.appendCommittedStateRecord(stateAfterStageA, intent, 'discard_pair_reveal');

    const { plan: stageBPlan } =
      await OldMaidCanonicalRules.compileDiscardPairContinuation(
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
      this.expectedTotalN,
      intent.actor_id
    );
    const projectedStageB = AtomicTransitionKernel.projectCandidateState(
      stateAfterStageA,
      candidateB
    );
    const patchB = await OldMaidCanonicalRules.reduceAfterCommit(
      'discard_pair_matched',
      intent.actor_id,
      projectedStageB,
      { rank: cardInstA.rank }
    );
    const finalState = await AtomicTransitionKernel.commitTransition(
      stateAfterStageA,
      candidateB,
      patchB,
      `Player ${intent.actor_id} discarded matching pair of ${cardInstA.rank}s (${cardInstA.symbol} & ${cardInstB.symbol})`
    );
    await this.stateLedger.appendState(finalState);
    await this.appendCommittedStateRecord(finalState, intent, 'discard_pair_move');
    this.checkAndApplyOutcome(finalState);
    return finalState;
  }

  private async executeRandomDrawIntent(
    intent: SignedSemanticIntent,
    baseState: CommittedGameState
  ): Promise<CommittedGameState> {
    if (!this.lockedRoster) throw new Error('Roster is required for random draw.');
    const ext = baseState.game_state_extension as { active_players: string[] };
    const targetPlayerId = OldMaidCanonicalRules.getNextActivePlayerId(
      ext.active_players,
      intent.actor_id,
      baseState
    );
    if (!targetPlayerId) throw new Error('No valid target player for random draw.');

    const targetZoneId = `zone_hand_${targetPlayerId}`;
    const destinationZoneId = `zone_hand_${intent.actor_id}`;
    const targetHand = baseState.zone_states[targetZoneId];
    if (!targetHand || targetHand.card_refs.length === 0) {
      throw new Error('Target hand is empty or missing.');
    }

    const randomContext = {
      workflow_id: intent.intent_id,
      parent_state_hash: baseState.state_hash,
      source_zone_id: targetZoneId,
      source_ref_set_commitment: targetHand.commitment_hash,
      card_count: targetHand.card_refs.length,
      participant_ids: this.lockedRoster.players.map(player => player.player_id),
      round: 1,
    };

    const commitments: Record<string, string> = {};
    const nonces: Record<string, string> = {};
    for (const player of this.lockedRoster.players) {
      const contribution = await MultipartyRandomIndexProtocol.generateCommitment(
        player.player_id,
        randomContext
      );
      commitments[player.player_id] = contribution.commitment;
      nonces[player.player_id] = contribution.nonce;
    }

    const { receipt, resolved_selection } =
      await MultipartyRandomIndexProtocol.finalizeSelectionWithProvenance(
        randomContext,
        commitments,
        nonces,
        targetHand.card_refs
      );
    this.receiptStore.set(receipt.receipt_hash, receipt);

    const resolvedSelection: ResolvedSelection = resolved_selection;
    const movePlan: OperationPlan = {
      operations: [
        {
          op_type: 'MOVE',
          source_zone_id: targetZoneId,
          destination_zone_id: destinationZoneId,
          resolved_selection: resolvedSelection,
          placement: 'TOP',
        },
      ],
      is_atomic: true,
      plan_hash: await hashCanonical({
        operation: 'verified_random_move',
        selected_ref: receipt.selected_ref,
        receipt_hash: receipt.receipt_hash,
      }),
    };

    const candidate = await AtomicTransitionKernel.simulatePlan(
      baseState,
      this.zoneDefinitions,
      movePlan,
      this.expectedTotalN,
      intent.actor_id,
      this.receiptStore,
      this.consumedReceipts
    );
    const projected = AtomicTransitionKernel.projectCandidateState(
      baseState,
      candidate
    );
    const patch = await OldMaidCanonicalRules.reduceAfterCommit(
      'draw_random_from_next_player',
      intent.actor_id,
      projected
    );
    const nextState = await AtomicTransitionKernel.commitTransition(
      baseState,
      candidate,
      patch,
      `Player ${intent.actor_id} drew 1 random card from ${targetPlayerId}`
    );

    await this.stateLedger.appendState(nextState);
    this.consumedReceipts.add(receipt.receipt_hash);
    await this.appendCommittedStateRecord(nextState, intent, 'random_draw');
    this.checkAndApplyOutcome(nextState);
    return nextState;
  }

  private async executeEndTurnIntent(
    intent: SignedSemanticIntent,
    baseState: CommittedGameState
  ): Promise<CommittedGameState> {
    const emptyPlan: OperationPlan = {
      operations: [],
      is_atomic: true,
      plan_hash: await hashCanonical({ operation: 'end_turn' }),
    };
    const candidate = await AtomicTransitionKernel.simulatePlan(
      baseState,
      this.zoneDefinitions,
      emptyPlan,
      this.expectedTotalN,
      intent.actor_id
    );
    const projected = AtomicTransitionKernel.projectCandidateState(
      baseState,
      candidate
    );
    const patch = await OldMaidCanonicalRules.reduceAfterCommit(
      'end_turn',
      intent.actor_id,
      projected
    );
    const nextState = await AtomicTransitionKernel.commitTransition(
      baseState,
      candidate,
      patch,
      `Player ${intent.actor_id} ended their turn.`
    );
    await this.stateLedger.appendState(nextState);
    await this.appendCommittedStateRecord(nextState, intent, 'end_turn');
    this.checkAndApplyOutcome(nextState);
    return nextState;
  }

  private checkAndApplyOutcome(state: CommittedGameState): void {
    const ext = state.game_state_extension as {
      active_players: string[];
      finished_players: string[];
    };
    const outcome = OldMaidCanonicalRules.evaluateOutcome(state, ext);
    if (outcome) {
      this.outcome = outcome;
      this.phase = 'GAME_OVER';
    }
  }

  public lookupCardInstance(ref: CardRef): CardInstance {
    const cardInstance = this.cardRefInstanceMap.get(ref.ref_id);
    if (!cardInstance) {
      throw new Error(
        `Cannot resolve CardRef ${ref.ref_id}@${ref.epoch}; trusted mapping is missing. Refusing heuristic plaintext fallback.`
      );
    }
    return cardInstance;
  }

  exportAuditBundle(): AuditVerifierBundle {
    if (!this.lockedDefinition || !this.lockedRoster || !this.stateLedger) {
      throw new Error('Cannot export audit bundle before game state exists.');
    }
    const snapshots = this.stateLedger.getAllSnapshots();
    const current = this.stateLedger.current;
    return this.transcriptRecorder.exportAuditBundle(
      this.gameId,
      this.pluginDescriptor,
      this.lockedRoster,
      this.lockedDefinition,
      snapshots[0]?.state_hash || 'GENESIS',
      current.state_hash,
      this.outcome || {
        outcome_type: 'GAME_STALLED',
        reason: 'Game still in progress; this is an interim audit bundle.',
        final_state_hash: current.state_hash,
        evidence_hashes: [],
      }
    );
  }
}
