/**
 * Mental Deck - Old Maid Canonical Rules Engine
 *
 * Pure rule validation/reduction. No wall clock, network, or RNG dependencies are
 * allowed in canonical output construction.
 */

import {
  CardInstance,
  CardRef,
  CommittedGameState,
  CoreOperation,
  GameTransitionPatch,
  OperationPlan,
  ProtocolOutcome,
  RuleDecision,
  SignedSemanticIntent,
  WorkflowContinuationAuthorization,
} from '../../types/contracts';
import { hashCanonical, sha256 } from '../../crypto/cryptoProvider';

interface OldMaidExtension {
  current_player_index: number;
  current_player_id: string;
  turn_number: number;
  draw_completed_this_turn: boolean;
  pairs_discarded_count: number;
  active_players: string[];
  finished_players: string[];
  history: string[];
}

export class OldMaidCanonicalRules {
  static async validateIntent(
    intent: SignedSemanticIntent,
    state: CommittedGameState
  ): Promise<RuleDecision> {
    const ext = state.game_state_extension as unknown as OldMaidExtension;

    if (intent.actor_id !== ext.current_player_id) {
      return {
        decision: 'REJECTED',
        canonical_code: 'NOT_ACTOR_TURN',
        reason: `It is player ${ext.current_player_id}'s turn, but received intent from ${intent.actor_id}`,
        output_hash: await sha256('REJECT:NOT_ACTOR_TURN'),
      };
    }

    const playerHandZoneId = `zone_hand_${intent.actor_id}`;
    const handState = state.zone_states[playerHandZoneId];
    if (!handState) {
      return {
        decision: 'REJECTED',
        canonical_code: 'ZONE_NOT_FOUND',
        reason: `Hand zone ${playerHandZoneId} not found in state`,
        output_hash: await sha256('REJECT:ZONE_NOT_FOUND'),
      };
    }

    switch (intent.action_type) {
      case 'discard_pair': {
        const cardRefA = intent.parameters.card_ref_a as CardRef;
        const cardRefB = intent.parameters.card_ref_b as CardRef;
        if (!cardRefA || !cardRefB || cardRefA.ref_id === cardRefB.ref_id) {
          return {
            decision: 'REJECTED',
            canonical_code: 'INVALID_PAIR_SELECTION',
            reason: 'Must select two distinct card refs for discard_pair',
            output_hash: await sha256('REJECT:INVALID_PAIR_SELECTION'),
          };
        }

        const handRefs = new Set(handState.card_refs.map(ref => ref.ref_id));
        if (!handRefs.has(cardRefA.ref_id) || !handRefs.has(cardRefB.ref_id)) {
          return {
            decision: 'REJECTED',
            canonical_code: 'CARD_NOT_IN_HAND',
            reason: 'One or both selected cards are not in player hand',
            output_hash: await sha256('REJECT:CARD_NOT_IN_HAND'),
          };
        }

        const revealPlan: OperationPlan = {
          operations: [
            {
              op_type: 'REVEAL_PUBLIC',
              card_refs: [cardRefA, cardRefB],
              viewers: ['PUBLIC'],
            },
          ],
          is_atomic: true,
          plan_hash: await hashCanonical({
            operation: 'discard_pair_reveal',
            actor_id: intent.actor_id,
            refs: [cardRefA, cardRefB],
            base_state_hash: state.state_hash,
          }),
        };

        return {
          decision: 'DISCLOSURE_REQUIRED',
          canonical_code: 'DISCLOSURE_STAGE_A',
          reason: 'Stage A: public disclosure required before rank comparison',
          allowed_operation_skeleton: revealPlan,
          continuation_required: true,
          continuation_type: 'DISCARD_PAIR_STAGE_B',
          output_hash: await sha256(
            `ALLOW:DISCARD_PAIR_STAGE_A:${intent.actor_id}:${cardRefA.ref_id}:${cardRefB.ref_id}:${state.state_hash}`
          ),
        };
      }

      case 'draw_random_from_next_player': {
        if (ext.draw_completed_this_turn) {
          return {
            decision: 'REJECTED',
            canonical_code: 'DRAW_ALREADY_COMPLETED',
            reason: 'Already drawn from next player this turn',
            output_hash: await sha256('REJECT:DRAW_ALREADY_COMPLETED'),
          };
        }

        const targetPlayerId = this.getNextActivePlayerId(
          ext.active_players,
          intent.actor_id,
          state
        );
        if (!targetPlayerId) {
          return {
            decision: 'REJECTED',
            canonical_code: 'NO_VALID_TARGET_PLAYER',
            reason: 'No other active player with cards is available',
            output_hash: await sha256('REJECT:NO_VALID_TARGET_PLAYER'),
          };
        }

        return {
          decision: 'ALLOWED',
          canonical_code: 'RANDOM_DRAW_ALLOWED',
          reason: `Allowed random draw from player ${targetPlayerId}`,
          continuation_required: false,
          output_hash: await sha256(
            `ALLOW:DRAW_FROM:${intent.actor_id}:${targetPlayerId}:${state.state_hash}`
          ),
        };
      }

      case 'end_turn': {
        if (!ext.draw_completed_this_turn && handState.card_refs.length > 0) {
          const nextTarget = this.getNextActivePlayerId(
            ext.active_players,
            intent.actor_id,
            state
          );
          if (nextTarget) {
            return {
              decision: 'REJECTED',
              canonical_code: 'MUST_DRAW_BEFORE_END_TURN',
              reason: 'Must draw from the next player before ending the turn',
              output_hash: await sha256('REJECT:MUST_DRAW_BEFORE_END_TURN'),
            };
          }
        }

        return {
          decision: 'ALLOWED',
          canonical_code: 'END_TURN_ALLOWED',
          reason: 'Turn end validated',
          continuation_required: false,
          output_hash: await sha256(
            `ALLOW:END_TURN:${intent.actor_id}:${state.state_hash}`
          ),
        };
      }

      default:
        return {
          decision: 'REJECTED',
          canonical_code: 'UNKNOWN_ACTION',
          reason: `Unknown action type: ${intent.action_type}`,
          output_hash: await sha256(`REJECT:UNKNOWN_ACTION:${intent.action_type}`),
        };
    }
  }

  static async validateDisclosedEvidence(
    _cardRefA: CardRef,
    cardInstanceA: CardInstance,
    _cardRefB: CardRef,
    cardInstanceB: CardInstance
  ): Promise<{ isMatch: boolean; reason: string }> {
    if (!cardInstanceA.rank || !cardInstanceB.rank) {
      return { isMatch: false, reason: 'Missing rank on card instances' };
    }
    const isMatch = cardInstanceA.rank === cardInstanceB.rank;
    return {
      isMatch,
      reason: isMatch
        ? `Matching rank '${cardInstanceA.rank}' found.`
        : `Rank mismatch: ${cardInstanceA.symbol} != ${cardInstanceB.symbol}`,
    };
  }

  static async compileDiscardPairContinuation(
    actorId: string,
    cardRefA: CardRef,
    cardRefB: CardRef,
    rank: string,
    workflowId: string,
    parentStateHash: string
  ): Promise<{
    plan: OperationPlan;
    continuationAuth: WorkflowContinuationAuthorization;
  }> {
    const orderedRefs = [cardRefA.ref_id, cardRefB.ref_id].sort();
    const groupDigest = await sha256(
      `PAIR_GROUP_V1:${workflowId}:${parentStateHash}:${actorId}:${rank}:${orderedRefs.join(':')}`
    );
    const groupId = `pair_${groupDigest.slice(0, 20)}`;

    const operations: CoreOperation[] = [
      {
        op_type: 'MOVE',
        source_zone_id: `zone_hand_${actorId}`,
        destination_zone_id: 'discarded_pairs',
        selection: {
          type: 'BY_HANDLE',
          card_refs: [cardRefA, cardRefB],
        },
        placement: 'TOP',
      },
      {
        op_type: 'GROUP',
        zone_id: 'discarded_pairs',
        group_id: groupId,
        card_refs: [cardRefA, cardRefB],
        label: `Pair of ${rank}s`,
      },
    ];

    const planHash = await hashCanonical(operations);
    const plan: OperationPlan = {
      operations,
      is_atomic: true,
      plan_hash: planHash,
    };

    const authorizationHash = await sha256(
      `CONTINUATION_AUTH_V1:${workflowId}:${parentStateHash}:${actorId}:${orderedRefs.join(':')}`
    );
    const continuationAuth: WorkflowContinuationAuthorization = {
      workflow_id: workflowId,
      origin_intent_hash: await sha256(`ORIGIN:${workflowId}`),
      parent_state_hash: parentStateHash,
      rule_decision_hash: await sha256(`MATCH:${rank}`),
      continuation_type: 'DISCARD_PAIR_STAGE_B',
      target_refs: [cardRefA, cardRefB],
      authorization_hash: authorizationHash,
    };

    return { plan, continuationAuth };
  }

  static getNextActivePlayerId(
    activePlayerIds: string[],
    currentActorId: string,
    state: CommittedGameState
  ): string | null {
    const currentIndex = activePlayerIds.indexOf(currentActorId);
    if (currentIndex === -1) return null;

    for (let offset = 1; offset < activePlayerIds.length; offset++) {
      const nextId =
        activePlayerIds[(currentIndex + offset) % activePlayerIds.length];
      const hand = state.zone_states[`zone_hand_${nextId}`];
      if (hand && hand.card_refs.length > 0) return nextId;
    }
    return null;
  }

  /**
   * `state` must represent the projected post-core-operation state. This prevents
   * hand-empty/finished-player detection from lagging one transition behind.
   */
  static async reduceAfterCommit(
    actionType: string,
    actorId: string,
    state: CommittedGameState,
    meta?: Record<string, unknown>
  ): Promise<GameTransitionPatch> {
    const previous = state.game_state_extension as unknown as OldMaidExtension;
    const next: OldMaidExtension = JSON.parse(JSON.stringify(previous));

    for (const playerId of previous.active_players) {
      const hand = state.zone_states[`zone_hand_${playerId}`];
      if (
        hand &&
        hand.card_refs.length === 0 &&
        !next.finished_players.includes(playerId)
      ) {
        next.finished_players.push(playerId);
        next.history.push(`Player ${playerId} emptied their hand.`);
      }
    }

    if (actionType === 'draw_random_from_next_player') {
      next.draw_completed_this_turn = true;
      next.history.push(`Player ${actorId} drew a card from the next player.`);
    } else if (actionType === 'discard_pair_matched') {
      next.pairs_discarded_count = (next.pairs_discarded_count || 0) + 1;
      next.history.push(
        `Player ${actorId} discarded a matching pair of ${(meta?.rank as string) ?? 'cards'}.`
      );
    } else if (actionType === 'discard_pair_mismatched') {
      next.history.push(
        `Player ${actorId} attempted a pair discard but the cards did not match.`
      );
    } else if (actionType === 'end_turn') {
      next.draw_completed_this_turn = false;
      next.turn_number += 1;
      const nextActor = this.getNextActivePlayerId(
        previous.active_players,
        actorId,
        state
      );
      if (nextActor) {
        next.current_player_id = nextActor;
        next.current_player_index = previous.active_players.indexOf(nextActor);
        next.history.push(
          `Turn ${next.turn_number} begins for player ${nextActor}.`
        );
      }
    }

    return {
      next_game_state_extension: next as unknown as Record<string, unknown>,
      next_extension_hash: await hashCanonical(next),
      outcome_hint: this.evaluateOutcome(state, next),
    };
  }

  static evaluateOutcome(
    state: CommittedGameState,
    ext: { active_players: string[]; finished_players: string[] }
  ): ProtocolOutcome | null {
    const discarded = state.zone_states.discarded_pairs?.card_refs.length ?? 0;
    if (discarded !== 50) return null;

    let loserId: string | null = null;
    for (const playerId of ext.active_players) {
      const hand = state.zone_states[`zone_hand_${playerId}`];
      if (hand?.card_refs.length === 1) {
        loserId = playerId;
        break;
      }
    }
    if (!loserId) return null;

    return {
      outcome_type: 'NORMAL_VICTORY',
      winner_player_ids: ext.active_players.filter(playerId => playerId !== loserId),
      loser_player_id: loserId,
      reason: `All 25 pairs were discarded. Player ${loserId} holds the unmatched Old Maid.`,
      final_state_hash: state.state_hash,
      evidence_hashes: [],
    };
  }
}
