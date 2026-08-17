/**
 * Mental Deck - Multiparty Random Index Protocol (MDD-MOD-015, MDD-GATE-002)
 *
 * Commit-before-reveal random selection with context binding and rejection sampling.
 * The coordinator currently orchestrates all contributions in one trusted process;
 * this module therefore proves deterministic receipt integrity, not network-level
 * independence of participants.
 */

import {
  CardRef,
  RandomSelectionContext,
  RandomSelectionReceipt,
  ResolvedSelection,
} from '../types/contracts';
import { hashCanonical, sha256 } from './cryptoProvider';

function requireCSPRNG(): Crypto {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error('Cryptographically secure randomness is required.');
  }
  return webCrypto;
}

export class MultipartyRandomIndexProtocol {
  static async generateCommitment(
    participantId: string,
    context: RandomSelectionContext
  ): Promise<{ nonce: string; commitment: string }> {
    const randomBuffer = new Uint8Array(32);
    requireCSPRNG().getRandomValues(randomBuffer);
    const nonce = Array.from(randomBuffer)
      .map(byte => byte.toString(16).padStart(2, '0'))
      .join('');
    const contextHash = await hashCanonical(context);
    const commitment = await sha256(
      `RANDOM_COMMIT_V1:${contextHash}:${participantId}:${nonce}`
    );
    return { nonce, commitment };
  }

  static async verifyReveal(
    participantId: string,
    nonce: string,
    priorCommitment: string,
    context: RandomSelectionContext
  ): Promise<boolean> {
    const contextHash = await hashCanonical(context);
    const expected = await sha256(
      `RANDOM_COMMIT_V1:${contextHash}:${participantId}:${nonce}`
    );
    return priorCommitment === expected;
  }

  /**
   * Exact 32-bit rejection sampling. If all SHA-256 chunks land in the rejection
   * tail, fail closed rather than fall back to a biased modulo operation.
   */
  static unbiasedSampleIndex(seedHex: string, cardCount: number): number {
    if (!Number.isInteger(cardCount) || cardCount <= 0 || cardCount >= 200) {
      throw new Error(`Invalid card count ${cardCount}; expected integer in [1, 200).`);
    }
    if (cardCount === 1) return 0;
    if (!/^[0-9a-f]{64}$/i.test(seedHex)) {
      throw new Error('Random seed must be a 32-byte SHA-256 hex digest.');
    }

    const range = 0x1_0000_0000; // 2^32 possible uint32 values.
    const limit = Math.floor(range / cardCount) * cardCount;

    for (let chunkIdx = 0; chunkIdx <= seedHex.length - 8; chunkIdx += 8) {
      const value = Number.parseInt(seedHex.slice(chunkIdx, chunkIdx + 8), 16);
      if (value < limit) {
        return value % cardCount;
      }
    }

    throw new Error('Rejection sampler exhausted seed chunks; protocol must stall rather than introduce modulo bias.');
  }

  static async finalizeSelection(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<RandomSelectionReceipt> {
    if (sourceHiddenRefs.length !== context.card_count) {
      throw new Error(
        `Random context card_count=${context.card_count} does not match source refs=${sourceHiddenRefs.length}`
      );
    }

    const actualSourceCommitment = await hashCanonical(sourceHiddenRefs);
    if (actualSourceCommitment !== context.source_ref_set_commitment) {
      throw new Error('Random selection source_ref_set_commitment does not match the supplied source vector.');
    }

    const contextHash = await hashCanonical(context);
    const uniqueParticipants = new Set(context.participant_ids);
    if (uniqueParticipants.size !== context.participant_ids.length) {
      throw new Error('Random selection participant_ids must be unique.');
    }

    for (const participantId of context.participant_ids) {
      const commitment = commitments[participantId];
      const nonce = revealedNonces[participantId];
      if (!commitment || !nonce) {
        throw new Error(`Missing random contribution from participant ${participantId}`);
      }
      const valid = await this.verifyReveal(
        participantId,
        nonce,
        commitment,
        context
      );
      if (!valid) {
        throw new Error(`Invalid reveal from participant ${participantId}`);
      }
    }

    const orderedNonces = context.participant_ids
      .slice()
      .sort()
      .map(participantId => `${participantId}:${revealedNonces[participantId]}`)
      .join('|');

    const derivedSeed = await sha256(
      `RANDOM_SEED_V1:${contextHash}:${orderedNonces}`
    );
    const unbiasedIndex = this.unbiasedSampleIndex(
      derivedSeed,
      context.card_count
    );
    const selectedRef = sourceHiddenRefs[unbiasedIndex];

    if (!selectedRef) {
      throw new Error(`Sampled index ${unbiasedIndex} is out of bounds.`);
    }

    const receiptHash = await sha256(
      `RANDOM_RECEIPT_V1:${contextHash}:${derivedSeed}:${unbiasedIndex}:${selectedRef.ref_id}`
    );

    return {
      context_hash: contextHash,
      source_zone_id: context.source_zone_id,
      source_ref_set_commitment: context.source_ref_set_commitment,
      workflow_id: context.workflow_id,
      parent_state_hash: context.parent_state_hash,
      commitments: { ...commitments },
      revealed_nonces: { ...revealedNonces },
      derived_seed: derivedSeed,
      unbiased_index: unbiasedIndex,
      selected_ref: selectedRef,
      receipt_hash: receiptHash,
      evidence_hash: receiptHash,
    };
  }

  /** Recompute and verify the entire receipt against the exact source vector. */
  static async verifyReceipt(
    receipt: RandomSelectionReceipt,
    context: RandomSelectionContext,
    sourceHiddenRefs: CardRef[]
  ): Promise<boolean> {
    try {
      if (receipt.context_hash !== (await hashCanonical(context))) return false;
      if (receipt.source_zone_id !== context.source_zone_id) return false;
      if (receipt.workflow_id !== context.workflow_id) return false;
      if (receipt.parent_state_hash !== context.parent_state_hash) return false;
      if (receipt.source_ref_set_commitment !== context.source_ref_set_commitment) return false;
      if (sourceHiddenRefs.length !== context.card_count) return false;
      if ((await hashCanonical(sourceHiddenRefs)) !== context.source_ref_set_commitment) return false;

      for (const participantId of context.participant_ids) {
        const commitment = receipt.commitments[participantId];
        const nonce = receipt.revealed_nonces[participantId];
        if (!commitment || !nonce) return false;
        if (!(await this.verifyReveal(participantId, nonce, commitment, context))) {
          return false;
        }
      }

      const orderedNonces = context.participant_ids
        .slice()
        .sort()
        .map(participantId => `${participantId}:${receipt.revealed_nonces[participantId]}`)
        .join('|');
      const derivedSeed = await sha256(
        `RANDOM_SEED_V1:${receipt.context_hash}:${orderedNonces}`
      );
      if (derivedSeed !== receipt.derived_seed) return false;

      const unbiasedIndex = this.unbiasedSampleIndex(
        derivedSeed,
        context.card_count
      );
      if (unbiasedIndex !== receipt.unbiased_index) return false;

      const selectedRef = sourceHiddenRefs[unbiasedIndex];
      if (!selectedRef || selectedRef.ref_id !== receipt.selected_ref.ref_id) return false;
      if (selectedRef.epoch !== receipt.selected_ref.epoch) return false;

      const expectedReceiptHash = await sha256(
        `RANDOM_RECEIPT_V1:${receipt.context_hash}:${derivedSeed}:${unbiasedIndex}:${selectedRef.ref_id}`
      );
      return receipt.receipt_hash === expectedReceiptHash;
    } catch {
      return false;
    }
  }

  static async finalizeSelectionWithProvenance(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<{
    receipt: RandomSelectionReceipt;
    resolved_selection: ResolvedSelection;
  }> {
    const receipt = await this.finalizeSelection(
      context,
      commitments,
      revealedNonces,
      sourceHiddenRefs
    );
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
