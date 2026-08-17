/**
 * Mental Deck - Committed State Ledger & Public/Audit Projection
 *
 * Snapshots are cloned on ingress/egress, state hashes are revalidated before
 * append, and hidden zone handle vectors are not exposed to unauthorized viewers.
 */

import {
  CardInstance,
  CommittedGameState,
  GameView,
  ZoneDefinition,
} from '../types/contracts';
import { hashCanonical } from '../crypto/cryptoProvider';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

export class StateLedger {
  private history: CommittedGameState[] = [];

  constructor(initialState?: CommittedGameState) {
    if (initialState) {
      this.history.push(cloneJson(initialState));
    }
  }

  private static stateHashPayload(state: CommittedGameState): Record<string, unknown> {
    return {
      state_version: state.state_version,
      prev_state_hash: state.prev_state_hash,
      zone_states: state.zone_states,
      groups: state.groups,
      public_bindings: state.public_bindings,
      grants: state.grants,
      game_state_extension: state.game_state_extension,
      game_state_extension_hash: state.game_state_extension_hash,
    };
  }

  static async assertStateIntegrity(state: CommittedGameState): Promise<void> {
    const extensionHash = await hashCanonical(state.game_state_extension);
    if (extensionHash !== state.game_state_extension_hash) {
      throw new Error('Committed state extension hash mismatch.');
    }

    const expectedStateHash = await hashCanonical(this.stateHashPayload(state));
    if (expectedStateHash !== state.state_hash) {
      throw new Error(
        `Committed state hash mismatch: expected ${expectedStateHash}, received ${state.state_hash}`
      );
    }
  }

  get current(): CommittedGameState {
    if (this.history.length === 0) {
      throw new Error('State ledger is empty');
    }
    return cloneJson(this.history[this.history.length - 1]);
  }

  get version(): number {
    return this.current.state_version;
  }

  getAllSnapshots(): CommittedGameState[] {
    return cloneJson(this.history);
  }

  async appendState(nextState: CommittedGameState): Promise<void> {
    await StateLedger.assertStateIntegrity(nextState);

    if (this.history.length > 0) {
      const prev = this.history[this.history.length - 1];
      if (nextState.state_version !== prev.state_version + 1) {
        throw new Error(
          `Invalid state version step: expected ${prev.state_version + 1}, received ${nextState.state_version}`
        );
      }
      if (nextState.prev_state_hash !== prev.state_hash) {
        throw new Error(
          `Broken state hash chain: expected prev_state_hash ${prev.state_hash}, received ${nextState.prev_state_hash}`
        );
      }
    }

    this.history.push(cloneJson(nextState));
  }

  projectGameView(
    viewerPlayerId: string | 'PUBLIC',
    gameId: string,
    zoneDefs: Record<string, ZoneDefinition>,
    localKnowledge?: LocalKnowledgeStore
  ): GameView {
    const state = this.current;

    const canSeeZoneHandles = (zoneDef: ZoneDefinition): boolean => {
      if (zoneDef.default_visibility === 'PUBLIC') return true;
      if (
        viewerPlayerId !== 'PUBLIC' &&
        zoneDef.owner_player_id === viewerPlayerId
      ) {
        return true;
      }
      return false;
    };

    const projectedZones = Object.values(zoneDefs).map(zoneDef => {
      const zoneState = state.zone_states[zoneDef.zone_id] || {
        zone_id: zoneDef.zone_id,
        card_refs: [],
        commitment_hash: '',
      };
      const visibleHandles = canSeeZoneHandles(zoneDef);

      const cards = visibleHandles
        ? zoneState.card_refs.map(ref => {
            const publicBinding = state.public_bindings[ref.ref_id];
            if (publicBinding) {
              return {
                ref_id: ref.ref_id,
                card_instance: publicBinding.card_instance,
                is_known: true,
              };
            }

            if (localKnowledge?.hasKnowledge(ref.ref_id)) {
              return {
                ref_id: ref.ref_id,
                card_instance:
                  localKnowledge.getKnownCard(ref.ref_id) ?? undefined,
                is_known: true,
              };
            }

            return {
              ref_id: ref.ref_id,
              is_known: false,
            };
          })
        : undefined;

      return {
        zone_id: zoneDef.zone_id,
        name: zoneDef.name,
        owner_player_id: zoneDef.owner_player_id,
        ordering: zoneDef.ordering,
        visibility: zoneDef.default_visibility,
        card_count: zoneState.card_refs.length,
        cards,
      };
    });

    const visibleGroups = Object.values(state.groups).filter(group => {
      const zoneDef = zoneDefs[group.zone_id];
      return zoneDef ? canSeeZoneHandles(zoneDef) : false;
    });

    const publicPairs = visibleGroups.map(group => {
      const cardInstances: CardInstance[] = [];
      for (const memberRef of group.member_refs) {
        const binding = state.public_bindings[memberRef.ref_id];
        if (binding) cardInstances.push(binding.card_instance);
      }
      return {
        group_id: group.group_id,
        cards: cardInstances,
      };
    });

    return {
      viewer_player_id: viewerPlayerId,
      game_id: gameId,
      state_version: state.state_version,
      state_hash: state.state_hash,
      zones: projectedZones,
      groups: cloneJson(visibleGroups),
      public_pairs: publicPairs,
      game_state_extension: cloneJson(state.game_state_extension),
      allowed_actions: [],
    };
  }
}
