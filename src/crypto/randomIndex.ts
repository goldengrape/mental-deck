/**
 * Mental Deck - Multiparty Verifiable Random Index Protocol (MDD-MOD-015, MDD-GATE-002)
 *
 * Implements:
 * 1. Commit-before-reveal fresh random nonces from each participant.
 * 2. Context & domain separation binding.
 * 3. Cryptographic unbiased sampling with rejection sampling to eliminate modulo bias.
 * 4. Ensures full hidden CardRef vector is NOT broadcast to non-source participants.
 * 5. One receipt per workflow; refusal leads to STALLED rather than unfair re-rolls.
 */

import {
  CardRef,
  RandomSelectionContext,
  RandomSelectionReceipt,
  ResolvedSelection,
} from '../types/contracts';
import { hashCanonical, sha256 } from './cryptoProvider';

export class MultipartyRandomIndexProtocol {
  /**
   * Generates a local fresh random nonce and its commitment
   */
  static async generateCommitment(
    participantId: string,
    context: RandomSelectionContext
  ): Promise<{ nonce: string; commitment: string }> {
    const randomBuffer = new Uint8Array(32);
    if (typeof crypto !== 'undefined' && crypto.getRandomValues) {
      crypto.getRandomValues(randomBuffer);
    } else {
      for (let i = 0; i < 32; i++) randomBuffer[i] = Math.floor(Math.random() * 256);
    }
    const nonce = Array.from(randomBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
    const contextHash = await hashCanonical(context);
    const commitment = await sha256(`RANDOM_COMMIT:${contextHash}:${participantId}:${nonce}`);
    return { nonce, commitment };
  }

  /**
   * Verifies that a revealed nonce matches the prior commitment
   */
  static async verifyReveal(
    participantId: string,
    nonce: string,
    priorCommitment: string,
    context: RandomSelectionContext
  ): Promise<boolean> {
    const contextHash = await hashCanonical(context);
    const expected = await sha256(`RANDOM_COMMIT:${contextHash}:${participantId}:${nonce}`);
    return priorCommitment === expected;
  }

  /**
   * Unbiased Rejection Sampling to eliminate modulo bias across any card count n in [1, 200)
   */
  static unbiasedSampleIndex(seedHex: string, cardCount: number): number {
    if (cardCount <= 0) {
      throw new Error(`Cannot sample from empty set of size ${cardCount}`);
    }
    if (cardCount === 1) return 0;

    // Use 32-bit chunk rejection sampling
    let chunkIdx = 0;
    while (chunkIdx < seedHex.length - 8) {
      const chunk = seedHex.substring(chunkIdx, chunkIdx + 8);
      const val = parseInt(chunk, 16);
      const limit = Math.floor(0xffffffff / cardCount) * cardCount;
      if (val < limit) {
        return val % cardCount;
      }
      chunkIdx += 8;
    }

    // Fallback deterministic pseudo-random fold if seed chunks exhausted
    let fallbackVal = 0;
    for (let i = 0; i < seedHex.length; i += 4) {
      fallbackVal = (fallbackVal ^ parseInt(seedHex.substring(i, i + 4), 16)) >>> 0;
    }
    return fallbackVal % cardCount;
  }

  /**
   * Finalizes the multi-party random selection and returns the verifiable receipt (MDD-API-020)
   */
  static async finalizeSelection(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<RandomSelectionReceipt> {
    // 1. Verify all required participants provided valid reveals
    const contextHash = await hashCanonical(context);
    for (const pid of context.participant_ids) {
      const commitment = commitments[pid];
      const nonce = revealedNonces[pid];
      if (!commitment || !nonce) {
        throw new Error(`Missing random contribution from participant ${pid}`);
      }
      const valid = await this.verifyReveal(pid, nonce, commitment, context);
      if (!valid) {
        throw new Error(`Invalid reveal from participant ${pid}`);
      }
    }

    // 2. Derive combined seed in canonical sorted order
    const orderedNonces = context.participant_ids
      .slice()
      .sort()
      .map(pid => `${pid}:${revealedNonces[pid]}`)
      .join('|');

    const derivedSeed = await sha256(`RANDOM_SEED:${contextHash}:${orderedNonces}`);

    // 3. Unbiased sample index
    const unbiasedIndex = this.unbiasedSampleIndex(derivedSeed, context.card_count);
    if (unbiasedIndex < 0 || unbiasedIndex >= sourceHiddenRefs.length) {
      throw new Error(`Sampled index ${unbiasedIndex} out of bounds for source refs count ${sourceHiddenRefs.length}`);
    }

    const selectedRef = sourceHiddenRefs[unbiasedIndex];
    const receiptHash = await sha256(
      `RANDOM_RECEIPT:${contextHash}:${derivedSeed}:${unbiasedIndex}:${selectedRef.ref_id}`
    );

    return {
      context_hash: contextHash,
      source_zone_id: context.source_zone_id,
      source_ref_set_commitment: context.source_ref_set_commitment,
      workflow_id: context.workflow_id,
      parent_state_hash: context.parent_state_hash,
      commitments,
      revealed_nonces: revealedNonces,
      derived_seed: derivedSeed,
      unbiased_index: unbiasedIndex,
      selected_ref: selectedRef,
      receipt_hash: receiptHash,
      evidence_hash: receiptHash,
    };
  }

  /**
   * Finalizes selection and produces both RandomSelectionReceipt + ResolvedSelection (VERIFIED_RANDOM)
   * conforming strictly to MDD-API-020
   */
  static async finalizeSelectionWithProvenance(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<{ receipt: RandomSelectionReceipt; resolved_selection: ResolvedSelection }> {
    const receipt = await this.finalizeSelection(context, commitments, revealedNonces, sourceHiddenRefs);
    const resolved_selection: ResolvedSelection = {
      selection_kind: 'VERIFIED_RANDOM',
      selected_card_refs: [receipt.selected_ref],
      selected_refs: [receipt.selected_ref],
      source_zone_id: context.source_zone_id,
      workflow_id: context.workflow_id,
      parent_state_hash: context.parent_state_hash,
      evidence_ref: receipt.receipt_hash,
      evidence_hash: receipt.receipt_hash,
    };
    return { receipt, resolved_selection };
  }
}
