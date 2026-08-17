/**
 * Mental Deck - Old Maid Client Contract & Intent Compiler
 *
 * Client intents are signed over every semantic field. The current prototype uses
 * the same exported P-256 private key string for both signing and demo shuffle
 * plumbing; production key separation is intentionally deferred.
 */

import {
  CardInstance,
  CardRef,
  CommittedGameState,
  SignedSemanticIntent,
} from '../../types/contracts';
import { MentalDeckCrypto } from '../../crypto/cryptoProvider';
import { LocalKnowledgeStore } from '../../crypto/localKnowledge';
import { OLD_MAID_PLUGIN_DESCRIPTOR } from './definition';

export class OldMaidClientContract {
  static findMatchingPairsInHand(
    playerHandRefs: CardRef[],
    localKnowledge: LocalKnowledgeStore
  ): Array<{
    cardA: { ref: CardRef; instance: CardInstance };
    cardB: { ref: CardRef; instance: CardInstance };
    rank: string;
  }> {
    const knownCards: Array<{ ref: CardRef; instance: CardInstance }> = [];
    for (const ref of playerHandRefs) {
      const instance = localKnowledge.getKnownCard(ref.ref_id);
      if (instance) knownCards.push({ ref, instance });
    }

    const pairs: Array<{
      cardA: { ref: CardRef; instance: CardInstance };
      cardB: { ref: CardRef; instance: CardInstance };
      rank: string;
    }> = [];
    const usedIndices = new Set<number>();

    for (let i = 0; i < knownCards.length; i++) {
      if (usedIndices.has(i)) continue;
      for (let j = i + 1; j < knownCards.length; j++) {
        if (usedIndices.has(j)) continue;
        if (
          knownCards[i].instance.rank &&
          knownCards[i].instance.rank === knownCards[j].instance.rank
        ) {
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

  static async compileAndSignIntent(
    actorId: string,
    actionType: 'discard_pair' | 'draw_random_from_next_player' | 'end_turn',
    parameters: Record<string, unknown>,
    currentState: CommittedGameState,
    signingPrivateKey: string
  ): Promise<SignedSemanticIntent> {
    if (!signingPrivateKey) {
      throw new Error('Missing signing private key for semantic intent.');
    }

    const randomBytes = new Uint8Array(8);
    globalThis.crypto.getRandomValues(randomBytes);
    const nonce = Array.from(randomBytes)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
    const timestamp = Date.now();

    const unsignedIntent: Omit<SignedSemanticIntent, 'signature'> = {
      intent_id: `intent_${timestamp}_${nonce}`,
      actor_id: actorId,
      plugin_id: OLD_MAID_PLUGIN_DESCRIPTOR.plugin_id,
      action_type: actionType,
      parameters,
      base_state_hash: currentState.state_hash,
      base_state_version: currentState.state_version,
      timestamp,
    };

    const signature = await MentalDeckCrypto.signIntent(
      signingPrivateKey,
      unsignedIntent
    );

    return {
      ...unsignedIntent,
      signature,
    };
  }
}
