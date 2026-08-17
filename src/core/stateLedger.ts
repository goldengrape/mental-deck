/**
 * Mental Deck - Committed State Ledger & privacy-preserving GameView projection.
 *
 * Ordinary viewers must never receive the complete stable CardRef vector for a Zone
 * they do not own and that is not PUBLIC. Counts/commitments live in server state;
 * the player projection exposes only information that viewer is authorized to know.
 */

import {
  CardInstance,
  CommittedGameState,
  GameView,
  ZoneDefinition,
} from '../types/contracts';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';

export class StateLedger {
  private history: CommittedGameState[] = [];

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
        // Do not expose hidden stable handles. Publicly disclosed cards are the only
        // exception because their CardRef->CardInstance binding is already public.
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
      game_state_extension: state.game_state_extension,
      allowed_actions: [],
    };
  }
}
