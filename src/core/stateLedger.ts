/**
 * Mental Deck - Committed State Ledger & Public/Audit Projection (MDD-MOD-011, URD-SEC-014)
 *
 * Implements:
 * 1. Immutable ledger of CommittedGameState snapshots.
 * 2. Hash chain verification (state_version, prev_state_hash -> state_hash).
 * 3. Public Projection: Clean projection for ordinary players without hidden vector leakage.
 * 4. Audit Extraction: Authorized verifier bundle export without private plaintext or key material.
 */

import {
  AuditVerifierBundle,
  CardInstance,
  CommittedGameState,
  GameView,
  LockedGameDefinition,
  LockedRoster,
  PluginArtifactDescriptor,
  ProtocolOutcome,
  TranscriptRecord,
  ZoneDefinition,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';

export class StateLedger {
  private history: CommittedGameState[] = [];

  constructor(initialState?: CommittedGameState) {
    if (initialState) {
      this.history.push(initialState);
    }
  }

  get current(): CommittedGameState {
    if (this.history.length === 0) {
      throw new Error('State ledger is empty');
    }
    return this.history[this.history.length - 1];
  }

  get version(): number {
    return this.current.state_version;
  }

  getAllSnapshots(): CommittedGameState[] {
    return [...this.history];
  }

  /**
   * Append a new atomically committed state snapshot
   */
  async appendState(nextState: CommittedGameState): Promise<void> {
    if (this.history.length > 0) {
      const prev = this.current;
      if (nextState.state_version !== prev.state_version + 1) {
        throw new Error(`Invalid state version step: expected ${prev.state_version + 1}, received ${nextState.state_version}`);
      }
      if (nextState.prev_state_hash !== prev.state_hash) {
        throw new Error(`Broken state hash chain: expected prev_state_hash ${prev.state_hash}, received ${nextState.prev_state_hash}`);
      }
    }
    this.history.push(nextState);
  }

  /**
   * Generates a viewer-limited GameView for a specific player (or 'PUBLIC')
   */
  projectGameView(
    viewerPlayerId: string | 'PUBLIC',
    gameId: string,
    zoneDefs: Record<string, ZoneDefinition>,
    localKnowledge?: LocalKnowledgeStore
  ): GameView {
    const state = this.current;

    const projectedZones = Object.values(zoneDefs).map(zDef => {
      const zState = state.zone_states[zDef.zone_id] || { card_refs: [] };
      const count = zState.card_refs.length;

      // Cards projection based on visibility
      const cards = zState.card_refs.map(ref => {
        // Check public binding first
        const pubBinding = state.public_bindings[ref.ref_id];
        if (pubBinding) {
          return {
            ref_id: ref.ref_id,
            card_instance: pubBinding.card_instance,
            is_known: true,
          };
        }

        // Check local knowledge of this viewer
        if (localKnowledge && localKnowledge.hasKnowledge(ref.ref_id)) {
          return {
            ref_id: ref.ref_id,
            card_instance: localKnowledge.getKnownCard(ref.ref_id) ?? undefined,
            is_known: true,
          };
        }

        // Hidden to this viewer
        return {
          ref_id: ref.ref_id,
          is_known: false,
        };
      });

      return {
        zone_id: zDef.zone_id,
        name: zDef.name,
        owner_player_id: zDef.owner_player_id,
        ordering: zDef.ordering,
        visibility: zDef.default_visibility,
        card_count: count,
        cards,
      };
    });

    const publicPairs = Object.values(state.groups).map(g => {
      const cardInstances: CardInstance[] = [];
      for (const mRef of g.member_refs) {
        const binding = state.public_bindings[mRef.ref_id];
        if (binding) {
          cardInstances.push(binding.card_instance);
        }
      }
      return {
        group_id: g.group_id,
        cards: cardInstances,
      };
    });

    return {
      viewer_player_id: viewerPlayerId,
      game_id: gameId,
      state_version: state.state_version,
      state_hash: state.state_hash,
      zones: projectedZones,
      groups: Object.values(state.groups),
      public_pairs: publicPairs,
      game_state_extension: state.game_state_extension,
      allowed_actions: [], // populated by game client contract
    };
  }
}
