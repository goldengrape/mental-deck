/**
 * Mental Deck - AI Player Agent.
 *
 * The AI receives the same semantic client contract as a human player and no
 * privileged Core/Coordinator write path.
 */

import {
  CommittedGameState,
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

  async decideNextAction(currentState: CommittedGameState): Promise<SignedSemanticIntent | null> {
    const ext = currentState.game_state_extension as {
      current_player_id: string;
      draw_completed_this_turn: boolean;
    };
    if (ext.current_player_id !== this.playerId) return null;

    const hand = currentState.zone_states[`zone_hand_${this.playerId}`];
    if (!hand) return null;

    // OldMaidGameBoard still constructs a legacy simulation LocalKeyMaterial where
    // signing_private_key is a placeholder and encryption_private_key carries the
    // actual per-player signing secret from the demo harness. Keep this compatibility
    // isolated here; real clients must populate LocalKeyMaterial correctly.
    const signingSecret = this.keyMaterial.signing_private_key.startsWith('sign_')
      ? this.keyMaterial.encryption_private_key
      : this.keyMaterial.signing_private_key;

    const pairs = OldMaidClientContract.findMatchingPairsInHand(hand.card_refs, this.localKnowledge);
    if (pairs.length > 0) {
      const bestPair = pairs[0];
      return OldMaidClientContract.compileAndSignIntent(
        this.playerId,
        'discard_pair',
        { card_ref_a: bestPair.cardA.ref, card_ref_b: bestPair.cardB.ref },
        currentState,
        signingSecret
      );
    }

    if (!ext.draw_completed_this_turn) {
      return OldMaidClientContract.compileAndSignIntent(
        this.playerId,
        'draw_random_from_next_player',
        {},
        currentState,
        signingSecret
      );
    }

    return OldMaidClientContract.compileAndSignIntent(
      this.playerId,
      'end_turn',
      {},
      currentState,
      signingSecret
    );
  }
}
