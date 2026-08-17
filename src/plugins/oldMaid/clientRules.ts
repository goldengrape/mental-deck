/**
 * Mental Deck - Old Maid Client Contract & Intent Compiler (MDD-MOD-025, URD-ARCH-002, URD-API-004)
 *
 * Implements client-side game view enrichment, local pair detection, and semantic intent construction.
 */

import {
  CardInstance,
  CardRef,
  CommittedGameState,
  GameView,
  SignedSemanticIntent,
} from '../../types/contracts';
import { MentalDeckCrypto, sha256 } from '../../crypto/cryptoProvider';
import { LocalKnowledgeStore } from '../../crypto/localKnowledge';
import { OLD_MAID_PLUGIN_DESCRIPTOR } from './definition';

export class OldMaidClientContract {
  /**
   * Scans local knowledge for any matching pairs of same rank in player's hand
   */
  static findMatchingPairsInHand(
    playerHandRefs: CardRef[],
    localKnowledge: LocalKnowledgeStore
  ): Array<{ cardA: { ref: CardRef; instance: CardInstance }; cardB: { ref: CardRef; instance: CardInstance }; rank: string }> {
    const knownCards: Array<{ ref: CardRef; instance: CardInstance }> = [];
    for (const ref of playerHandRefs) {
      const inst = localKnowledge.getKnownCard(ref.ref_id);
      if (inst) {
        knownCards.push({ ref, instance: inst });
      }
    }

    const pairs: Array<{ cardA: { ref: CardRef; instance: CardInstance }; cardB: { ref: CardRef; instance: CardInstance }; rank: string }> = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < knownCards.length; i++) {
      if (usedIndices.has(i)) continue;
      for (let j = i + 1; j < knownCards.length; j++) {
        if (usedIndices.has(j)) continue;
        if (knownCards[i].instance.rank && knownCards[i].instance.rank === knownCards[j].instance.rank) {
          pairs.push({
            cardA: knownCards[i],
            cardB: knownCards[j],
            rank: knownCards[i].instance.rank!,
          });
          usedIndices.add(i);
          usedIndices.add(j);
          break;
        }
      }
    }

    return pairs;
  }

  /**
   * Compiles a player's action intent into a cryptographically signed SignedSemanticIntent
   */
  static async compileAndSignIntent(
    actorId: string,
    actionType: 'discard_pair' | 'draw_random_from_next_player' | 'end_turn',
    parameters: Record<string, unknown>,
    currentState: CommittedGameState,
    signingPrivateKey: string
  ): Promise<SignedSemanticIntent> {
    const intentId = `intent_${Date.now()}_${Math.floor(Math.random() * 10000)}`;
    const timestamp = Date.now();

    const unsignedPayload = {
      intent_id: intentId,
      actor_id: actorId,
      plugin_id: OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id,
      action_type: actionType,
      parameters,
      base_state_hash: currentState.state_hash,
      base_state_version: currentState.state_version,
      timestamp,
    };

    const signature = await sha256(`INTENT_SIG:${signingPrivateKey}:${currentState.state_hash}:${actionType}`);

    return {
      ...unsignedPayload,
      signature,
    };
  }
}
