/**
 * Mental Deck - Old Maid client helpers.
 *
 * The legacy semantic-intent compiler is retained for the current Quiet Table UI.
 * New v0.10 clients use GameClientRuntime and the manifest-declared mechanical/event IDs.
 */

import {
  CardInstance,
  CardRef,
  CommittedGameState,
  SignedSemanticIntent,
} from '../../types/contracts';
import { MentalDeckCrypto } from '../../crypto/cryptoProvider';
import { LocalKnowledgeStore } from '../../crypto/localKnowledge';
import { GameClientRuntime } from '../../client/gameClientRuntime';
import { OLD_MAID_PLUGIN_DESCRIPTOR } from './definition';
import { OLD_MAID_GAME_MANIFEST } from './package';

/** @deprecated v0.9 compatibility for the existing visual prototype. */
export class OldMaidClientContract {
  static findMatchingPairsInHand(
    playerHandRefs: CardRef[],
    localKnowledge: LocalKnowledgeStore
  ): Array<{ cardA: { ref: CardRef; instance: CardInstance }; cardB: { ref: CardRef; instance: CardInstance }; rank: string }> {
    const knownCards: Array<{ ref: CardRef; instance: CardInstance }> = [];
    for (const ref of playerHandRefs) {
      const inst = localKnowledge.getKnownCard(ref.ref_id);
      if (inst) knownCards.push({ ref, instance: inst });
    }

    const pairs: Array<{ cardA: { ref: CardRef; instance: CardInstance }; cardB: { ref: CardRef; instance: CardInstance }; rank: string }> = [];
    const usedIndices = new Set<number>();
    for (let i = 0; i < knownCards.length; i++) {
      if (usedIndices.has(i)) continue;
      for (let j = i + 1; j < knownCards.length; j++) {
        if (usedIndices.has(j)) continue;
        const rank = knownCards[i].instance.rank;
        if (rank && rank === knownCards[j].instance.rank) {
          pairs.push({ cardA: knownCards[i], cardB: knownCards[j], rank });
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
    if (!signingPrivateKey) throw new Error('Cannot sign semantic intent without local signing private key');

    const intentId = `intent_${Date.now()}_${crypto.getRandomValues(new Uint32Array(1))[0].toString(16)}`;
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

    const signature = await MentalDeckCrypto.signSemanticIntent(signingPrivateKey, unsignedPayload);
    return { ...unsignedPayload, signature };
  }
}

export function createOldMaidV010ClientRuntime(
  playerId: string,
  securityDefinitionHash: string,
  signingPrivateKey: string
): GameClientRuntime {
  return new GameClientRuntime(
    playerId,
    OLD_MAID_GAME_MANIFEST.game.id,
    securityDefinitionHash,
    signingPrivateKey,
    OLD_MAID_GAME_MANIFEST
  );
}
