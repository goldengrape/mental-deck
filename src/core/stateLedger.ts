/**
 * Mental Deck - Committed State Ledger & privacy-preserving GameView projection.
 *
 * v0.10 uses one StateLedger total order for mechanical, public-game-event and
 * protocol transitions. Rule Advisor views are derived outside this ledger and never
 * enter the Core state hash or authorization path.
 */

import {
  CardInstance,
  CommittedGameState,
  GameView,
  StateTransitionRecord,
  ZoneDefinition,
} from '../types/contracts';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';

export class StateLedger {
  private history: CommittedGameState[] = [];
  private transitions: StateTransitionRecord[] = [];

  constructor(initialState?: CommittedGameState) {
    if (initialState) this.history.push(initialState);
  }

  get current(): CommittedGameState {
    if (this.history.length === 0) throw new Error('State ledger is empty');
    return this.history[this.history.length - 1];
  }

  get version(): number {
    return this.current.state_version;
  }

  getAllSnapshots(): CommittedGameState[] {
    return [...this.history];
  }

  getTransitionStream(): StateTransitionRecord[] {
    return this.transitions.map(record => ({ ...record, public_payload: { ...record.public_payload } }));
  }

  async appendState(nextState: CommittedGameState): Promise<void> {
    this.validateNextState(nextState);
    this.history.push(nextState);
  }

  async appendTransition(nextState: CommittedGameState, record: StateTransitionRecord): Promise<void> {
    this.validateNextState(nextState);
    if (record.state_version !== nextState.state_version) {
      throw new Error(`Transition/state version mismatch: ${record.state_version} != ${nextState.state_version}`);
    }
    if (record.base_state_hash !== this.current.state_hash || record.base_state_version !== this.current.state_version) {
      throw new Error('StateTransitionRecord is not bound to the current ledger head');
    }
    if (record.resulting_state_hash !== nextState.state_hash) {
      throw new Error('StateTransitionRecord resulting_state_hash mismatch');
    }
    if (nextState.last_transition_commitment !== record.transition_commitment) {
      throw new Error('Committed state does not bind the transition commitment');
    }
    this.history.push(nextState);
    this.transitions.push(record);
  }

  private validateNextState(nextState: CommittedGameState): void {
    if (this.history.length === 0) return;
    const prev = this.current;
    if (nextState.state_version !== prev.state_version + 1) {
      throw new Error(`Invalid state version step: expected ${prev.state_version + 1}, received ${nextState.state_version}`);
    }
    if (nextState.prev_state_hash !== prev.state_hash) {
      throw new Error(`Broken state hash chain: expected prev_state_hash ${prev.state_hash}, received ${nextState.prev_state_hash}`);
    }
  }

  projectGameView(
    viewerPlayerId: string | 'PUBLIC',
    gameId: string,
    zoneDefs: Record<string, ZoneDefinition>,
    localKnowledge?: LocalKnowledgeStore
  ): GameView {
    const state = this.current;

    const projectedZones = Object.values(zoneDefs).map(zDef => {
      const zState = state.zone_states[zDef.zone_id] || { card_refs: [] };
      const cardCount = zState.card_refs.length;
      const viewerOwnsZone = viewerPlayerId !== 'PUBLIC' && zDef.owner_player_id === viewerPlayerId;
      const maySeeFullRefVector = zDef.default_visibility === 'PUBLIC' || viewerOwnsZone;
      const cards: NonNullable<GameView['zones'][number]['cards']> = [];

      if (maySeeFullRefVector) {
        for (const ref of zState.card_refs) {
          const pubBinding = state.public_bindings[ref.ref_id];
          const locallyKnown = localKnowledge?.getKnownCard(ref.ref_id) ?? undefined;
          cards.push({
            ref_id: ref.ref_id,
            card_instance: pubBinding?.card_instance ?? locallyKnown,
            is_known: !!pubBinding || !!locallyKnown,
          });
        }
      } else {
        // Hidden stable handles are not projected. Publicly disclosed cards are the
        // only exception because their binding is already public knowledge.
        for (const ref of zState.card_refs) {
          const pubBinding = state.public_bindings[ref.ref_id];
          if (pubBinding) {
            cards.push({
              ref_id: ref.ref_id,
              card_instance: pubBinding.card_instance,
              is_known: true,
            });
          }
        }
      }

      return {
        zone_id: zDef.zone_id,
        name: zDef.name,
        owner_player_id: zDef.owner_player_id,
        ordering: zDef.ordering,
        visibility: zDef.default_visibility,
        card_count: cardCount,
        cards,
      };
    });

    const publicGroups = Object.values(state.groups).filter(group => {
      const zDef = zoneDefs[group.zone_id];
      return zDef?.default_visibility === 'PUBLIC';
    });

    const publicPairs = publicGroups.map(group => {
      const cardInstances: CardInstance[] = [];
      for (const ref of group.member_refs) {
        const binding = state.public_bindings[ref.ref_id];
        if (binding) cardInstances.push(binding.card_instance);
      }
      return { group_id: group.group_id, cards: cardInstances };
    });

    return {
      viewer_player_id: viewerPlayerId,
      game_id: gameId,
      state_version: state.state_version,
      state_hash: state.state_hash,
      zones: projectedZones,
      groups: publicGroups,
      public_pairs: publicPairs,
      // Compatibility-only UI field. New Rule Advisor views are derived outside Core.
      game_state_extension: state.game_state_extension,
      allowed_actions: [],
    };
  }
}
