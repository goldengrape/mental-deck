/**
 * Mental Deck - AI Player Agent
 *
 * The AI uses the same client contract and authenticated semantic-intent path as
 * human players. It receives no coordinator bypass or privileged rule access.
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

  async decideNextAction(
    currentState: CommittedGameState
  ): Promise<SignedSemanticIntent | null> {
    const ext = currentState.game_state_extension as {
      current_player_id: string;
      draw_completed_this_turn: boolean;
    };

    if (ext.current_player_id !== this.playerId) return null;

    const handZoneId = `zone_hand_${this.playerId}`;
    const hand = currentState.zone_states[handZoneId];
    if (!hand) return null;

    // The prototype currently reuses the P-256 private key stored in the
    // encryption slot for both intent signing and demo shuffle plumbing.
    const signingPrivateKey = this.keyMaterial.encryption_private_key;
    if (!signingPrivateKey) {
      throw new Error(`AI player ${this.playerId} has no authenticated private key.`);
    }

    const pairs = OldMaidClientContract.findMatchingPairsInHand(
      hand.card_refs,
      this.localKnowledge
    );
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
        signingPrivateKey
      );
    }

    if (!ext.draw_completed_this_turn) {
      return OldMaidClientContract.compileAndSignIntent(
        this.playerId,
        'draw_random_from_next_player',
        {},
        currentState,
        signingPrivateKey
      );
    }

    return OldMaidClientContract.compileAndSignIntent(
      this.playerId,
      'end_turn',
      {},
      currentState,
      signingPrivateKey
    );
  }
}
