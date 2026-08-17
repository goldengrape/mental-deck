/**
 * Mental Deck - Old Maid Canonical Rules Engine (MDD-MOD-012, MDD-MOD-028, URD-GAME-OM-005 to 010)
 *
 * Implements:
 * 1. Server-authoritative deterministic rule validation (no wall-clock/network/RNG dependencies).
 * 2. Staged discard_pair verification: Public reveal -> Validate rank equality -> If match: MOVE+GROUP to DiscardedPairs. If mismatch: Keep in Hand, knowledge permanent.
 * 3. draw_random_from_next_player targeting next active player with remaining cards.
 * 4. Outcome evaluator: 25 pairs (50 cards) discarded -> 1 card left -> Player holding it is loser!
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

export class OldMaidCanonicalRules {
  /**
   * Validates player signed intent against current committed game state
   */
  static async validateIntent(
    intent: SignedSemanticIntent,
    state: CommittedGameState
  ): Promise<RuleDecision> {
    const ext = state.game_state_extension as {
      current_player_id: string;
      draw_completed_this_turn: boolean;
      active_players: string[];
      finished_players: string[];
    };

    // 1. Check actor is current player
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

        // Verify both cards exist in actor's hand
        const handRefs = new Set(handState.card_refs.map(r => r.ref_id));
        if (!handRefs.has(cardRefA.ref_id) || !handRefs.has(cardRefB.ref_id)) {
          return {
            decision: 'REJECTED',
            canonical_code: 'CARD_NOT_IN_HAND',
            reason: 'One or both selected cards are not in player hand',
            output_hash: await sha256('REJECT:CARD_NOT_IN_HAND'),
          };
        }

        // discard_pair requires public disclosure stage first! (URD-GAME-OM-006)
        const revealPlan: OperationPlan = {
          operations: [
            {
              op_type: 'REVEAL_PUBLIC',
              card_refs: [cardRefA, cardRefB],
              viewers: ['PUBLIC'],
            },
          ],
          is_atomic: true,
          plan_hash: await hashCanonical([cardRefA.ref_id, cardRefB.ref_id]),
        };

        return {
          decision: 'DISCLOSURE_REQUIRED',
          canonical_code: 'DISCLOSURE_STAGE_A',
          reason: 'Stage A: Public disclosure grant required before verifying rank equality',
          allowed_operation_skeleton: revealPlan,
          continuation_required: true,
          continuation_type: 'DISCARD_PAIR_STAGE_B',
          output_hash: await sha256(`ALLOW:DISCARD_PAIR_STAGE_A:${cardRefA.ref_id}:${cardRefB.ref_id}`),
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

        const targetPlayerId = this.getNextActivePlayerId(ext.active_players, intent.actor_id, state);
        if (!targetPlayerId) {
          return {
            decision: 'REJECTED',
            canonical_code: 'NO_VALID_TARGET_PLAYER',
            reason: 'No other active players with cards found to draw from',
            output_hash: await sha256('REJECT:NO_VALID_TARGET_PLAYER'),
          };
        }

        return {
          decision: 'ALLOWED',
          canonical_code: 'RANDOM_DRAW_ALLOWED',
          reason: `Allowed random draw from player ${targetPlayerId}`,
          continuation_required: false,
          output_hash: await sha256(`ALLOW:DRAW_FROM:${targetPlayerId}`),
        };
      }

      case 'end_turn': {
        // Can end turn if draw has been completed or no other players have cards
        if (!ext.draw_completed_this_turn && handState.card_refs.length > 0) {
          const nextTarget = this.getNextActivePlayerId(ext.active_players, intent.actor_id, state);
          if (nextTarget) {
            return {
              decision: 'REJECTED',
              canonical_code: 'MUST_DRAW_BEFORE_END_TURN',
              reason: 'Must draw from next player before ending turn (URD-GAME-OM-009)',
              output_hash: await sha256('REJECT:MUST_DRAW_BEFORE_END_TURN'),
            };
          }
        }

        return {
          decision: 'ALLOWED',
          canonical_code: 'END_TURN_ALLOWED',
          reason: 'Turn end validated',
          continuation_required: false,
          output_hash: await sha256('ALLOW:END_TURN'),
        };
      }

      default:
        return {
          decision: 'REJECTED',
          canonical_code: 'UNKNOWN_ACTION',
          reason: `Unknown action type: ${intent.action_type}`,
          output_hash: await sha256('REJECT:UNKNOWN_ACTION'),
        };
    }
  }

  /**
   * Stage B: Validates rank equality on publicly disclosed cards
   */
  static async validateDisclosedEvidence(
    cardRefA: CardRef,
    cardInstanceA: CardInstance,
    cardRefB: CardRef,
    cardInstanceB: CardInstance
  ): Promise<{ isMatch: boolean; reason: string }> {
    if (!cardInstanceA.rank || !cardInstanceB.rank) {
      return { isMatch: false, reason: 'Missing rank on card instances' };
    }
    const isMatch = cardInstanceA.rank === cardInstanceB.rank;
    const reason = isMatch
      ? `Matching rank '${cardInstanceA.rank}' found! Pair confirmed.`
      : `Rank mismatch: ${cardInstanceA.symbol} (${cardInstanceA.rank}) != ${cardInstanceB.symbol} (${cardInstanceB.rank}). Cards remain in hand.`;
    return { isMatch, reason };
  }

  /**
   * Compiles Continuation for Stage B of discard_pair
   */
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
    const groupId = `pair_${rank}_${Date.now()}`;
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
    const plan: OperationPlan = { operations, is_atomic: true, plan_hash: planHash };

    const authHash = await sha256(
      `CONTINUATION_AUTH:${workflowId}:${parentStateHash}:${cardRefA.ref_id}:${cardRefB.ref_id}`
    );

    const continuationAuth: WorkflowContinuationAuthorization = {
      workflow_id: workflowId,
      origin_intent_hash: await sha256(`ORIGIN:${workflowId}`),
      parent_state_hash: parentStateHash,
      rule_decision_hash: await sha256(`MATCH:${rank}`),
      continuation_type: 'DISCARD_PAIR_STAGE_B',
      target_refs: [cardRefA, cardRefB],
      authorization_hash: authHash,
    };

    return { plan, continuationAuth };
  }

  /**
   * Determines the next active player with > 0 cards
   */
  static getNextActivePlayerId(
    activePlayerIds: string[],
    currentActorId: string,
    state: CommittedGameState
  ): string | null {
    const currentIndex = activePlayerIds.indexOf(currentActorId);
    if (currentIndex === -1) return null;

    const count = activePlayerIds.length;
    for (let offset = 1; offset < count; offset++) {
      const nextId = activePlayerIds[(currentIndex + offset) % count];
      const zState = state.zone_states[`zone_hand_${nextId}`];
      if (zState && zState.card_refs.length > 0) {
        return nextId;
      }
    }
    return null;
  }

  /**
   * Pure deterministic Reducer to advance Old Maid game state extension
   */
  static async reduceAfterCommit(
    actionType: string,
    actorId: string,
    state: CommittedGameState,
    meta?: Record<string, unknown>
  ): Promise<GameTransitionPatch> {
    const prevExt = state.game_state_extension as {
      current_player_index: number;
      current_player_id: string;
      turn_number: number;
      draw_completed_this_turn: boolean;
      pairs_discarded_count: number;
      active_players: string[];
      finished_players: string[];
      history: string[];
    };

    const nextExt = JSON.parse(JSON.stringify(prevExt));

    // Check which players now have 0 cards and mark them finished (they won/escaped!)
    for (const pid of prevExt.active_players) {
      const hand = state.zone_states[`zone_hand_${pid}`];
      if (hand && hand.card_refs.length === 0 && !nextExt.finished_players.includes(pid)) {
        nextExt.finished_players.push(pid);
        nextExt.history.push(`🎉 Player ${pid} has emptied their hand and escaped!`);
      }
    }

    if (actionType === 'draw_random_from_next_player') {
      nextExt.draw_completed_this_turn = true;
      nextExt.history.push(`Player ${actorId} drew a card from next player.`);
    } else if (actionType === 'discard_pair_matched') {
      nextExt.pairs_discarded_count = (nextExt.pairs_discarded_count || 0) + 1;
      nextExt.history.push(`Player ${actorId} discarded a matching pair of ${(meta?.rank as string) ?? 'cards'}.`);
    } else if (actionType === 'discard_pair_mismatched') {
      nextExt.history.push(`Player ${actorId} attempted pair discard but cards did not match.`);
    } else if (actionType === 'end_turn') {
      nextExt.draw_completed_this_turn = false;
      nextExt.turn_number += 1;

      // Advance to next player who still has cards
      const nextActor = this.getNextActivePlayerId(prevExt.active_players, actorId, state);
      if (nextActor) {
        nextExt.current_player_id = nextActor;
        nextExt.current_player_index = prevExt.active_players.indexOf(nextActor);
        nextExt.history.push(`Turn ${nextExt.turn_number} begins for player ${nextActor}.`);
      }
    }

    // Check game outcome
    const outcome = this.evaluateOutcome(state, nextExt);
    const nextExtHash = await hashCanonical(nextExt);

    return {
      next_game_state_extension: nextExt,
      next_extension_hash: nextExtHash,
      outcome_hint: outcome,
    };
  }

  /**
   * Evaluates if game is finished (50 cards in DiscardedPairs, 1 card left)
   */
  static evaluateOutcome(
    state: CommittedGameState,
    ext: { active_players: string[]; finished_players: string[] }
  ): ProtocolOutcome | null {
    const discardZone = state.zone_states['discarded_pairs'];
    const totalDiscarded = discardZone ? discardZone.card_refs.length : 0;

    // In 51-card Old Maid: 50 cards discarded = 25 pairs formed
    if (totalDiscarded === 50) {
      // Find the player holding the 51st card (Old Maid)
      let loserId: string | null = null;
      for (const pid of ext.active_players) {
        const hand = state.zone_states[`zone_hand_${pid}`];
        if (hand && hand.card_refs.length === 1) {
          loserId = pid;
          break;
        }
      }

      const winners = ext.active_players.filter(p => p !== loserId);
      return {
        outcome_type: 'NORMAL_VICTORY',
        winner_player_ids: winners,
        loser_player_id: loserId,
        reason: `Game Over! All 25 pairs discarded. Player ${loserId} holds the Queen of Spades (Old Maid) and loses!`,
        final_state_hash: state.state_hash,
        evidence_hashes: [],
      };
    }

    return null;
  }
}
