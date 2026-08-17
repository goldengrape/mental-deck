/**
 * Mental Deck - AI Player Agent (MDD-MOD-027, URD-ROLE-002, URD-API-003)
 *
 * Implements:
 * 1. Executes the exact same Game Client Contract as human players.
 * 2. Uses only its own authorized LocalKnowledgeStore and public CommittedGameState.
 * 3. Proposes signed semantic intents through canonical Coordinator API with zero special privileges.
 */

import {
  CardRef,
  CommittedGameState,
  GameView,
  LocalKeyMaterial,
  SignedSemanticIntent,
} from '../types/contracts';
import { LocalKnowledgeStore } from '../crypto/localKnowledge';
import { OldMaidClientContract } from '../plugins/oldMaid/clientRules';

export class AiGameAgent {
  public localKnowledge: LocalKnowledgeStore;

  constructor(
    public readonly playerId: string,
    public readonly gameId: string,
    public readonly keyMaterial: LocalKeyMaterial
  ) {
    this.localKnowledge = new LocalKnowledgeStore(playerId, gameId);
  }

  /**
   * Evaluates current game view and decides the optimal legal semantic action
   */
  async decideNextAction(
    currentState: CommittedGameState
  ): Promise<SignedSemanticIntent | null> {
    const ext = currentState.game_state_extension as {
      current_player_id: string;
      draw_completed_this_turn: boolean;
    };

    // Only take action on own turn
    if (ext.current_player_id !== this.playerId) {
      return null;
    }

    const handZoneId = `zone_hand_${this.playerId}`;
    const hand = currentState.zone_states[handZoneId];
    if (!hand) return null;

    // 1. Scan hand for any matching pairs to discard first
    const pairs = OldMaidClientContract.findMatchingPairsInHand(hand.card_refs, this.localKnowledge);
    if (pairs.length > 0) {
      const bestPair = pairs[0];
      return OldMaidClientContract.compileAndSignIntent(
        this.playerId,
        'discard_pair',
        {
          card_ref_a: bestPair.cardA.ref,
          card_ref_b: bestPair.cardB.ref,
        },
        currentState,
        this.keyMaterial.signing_private_key
      );
    }

    // 2. If not drawn yet this turn, perform random draw from next player
    if (!ext.draw_completed_this_turn) {
      return OldMaidClientContract.compileAndSignIntent(
        this.playerId,
        'draw_random_from_next_player',
        {},
        currentState,
        this.keyMaterial.signing_private_key
      );
    }

    // 3. Otherwise, end turn
    return OldMaidClientContract.compileAndSignIntent(
      this.playerId,
      'end_turn',
      {},
      currentState,
      this.keyMaterial.signing_private_key
    );
  }
}
