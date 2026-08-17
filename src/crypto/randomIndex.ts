/**
 * Mental Deck - Multiparty Verifiable Random Index Protocol.
 *
 * This module implements protocol/state-machine mechanics only. It does not turn the
 * current SimulationCryptoProvider into production cryptography.
 */

import {
  CardRef,
  RandomSelectionContext,
  RandomSelectionReceipt,
  ResolvedSelection,
} from '../types/contracts';
import { hashCanonical, sha256 } from './cryptoProvider';

export class MultipartyRandomIndexProtocol {
  static async generateCommitment(
    participantId: string,
    context: RandomSelectionContext
  ): Promise<{ nonce: string; commitment: string }> {
    if (typeof crypto === 'undefined' || !crypto.getRandomValues) {
      throw new Error('CSPRNG unavailable: random contribution generation fails closed');
    }
    const randomBuffer = new Uint8Array(32);
    crypto.getRandomValues(randomBuffer);
    const nonce = Array.from(randomBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
    const contextHash = await hashCanonical(context);
    const commitment = await sha256(`RANDOM_COMMIT:${contextHash}:${participantId}:${nonce}`);
    return { nonce, commitment };
  }

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
   * Rejection sampling over independent 32-bit chunks from a SHA-256 seed.
   * If every chunk falls into the rejection tail, fail closed and let the protocol
   * derive a fresh domain-separated seed in a future round; never fall back to `% n`.
   */
  static unbiasedSampleIndex(seedHex: string, cardCount: number): number {
    if (!Number.isInteger(cardCount) || cardCount <= 0 || cardCount >= 200) {
      throw new Error(`Invalid random-selection cardCount=${cardCount}; expected 1 <= N < 200`);
    }
    if (cardCount === 1) return 0;
    if (!/^[0-9a-fA-F]{64}$/.test(seedHex)) {
      throw new Error('Random seed must be a 32-byte SHA-256 hex value');
    }

    const range = 0x1_0000_0000; // 2^32
    const limit = Math.floor(range / cardCount) * cardCount;
    for (let offset = 0; offset <= seedHex.length - 8; offset += 8) {
      const val = Number.parseInt(seedHex.slice(offset, offset + 8), 16);
      if (val < limit) return val % cardCount;
    }

    throw new Error('All SHA-256 chunks landed in rejection tail; refuse biased fallback');
  }

  static async finalizeSelection(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<RandomSelectionReceipt> {
    if (sourceHiddenRefs.length !== context.card_count) {
      throw new Error(`Random context card_count=${context.card_count} does not match source refs=${sourceHiddenRefs.length}`);
    }
    const actualSourceCommitment = await hashCanonical(sourceHiddenRefs);
    if (actualSourceCommitment !== context.source_ref_set_commitment) {
      throw new Error('Random context source_ref_set_commitment does not match supplied hidden source vector');
    }

    const uniqueParticipants = new Set(context.participant_ids);
    if (uniqueParticipants.size !== context.participant_ids.length || uniqueParticipants.size < 2) {
      throw new Error('Random selection requires a unique multi-party participant set');
    }

    const contextHash = await hashCanonical(context);
    for (const pid of context.participant_ids) {
      const commitment = commitments[pid];
      const nonce = revealedNonces[pid];
      if (!commitment || !nonce) throw new Error(`Missing random contribution from participant ${pid}`);
      if (!(await this.verifyReveal(pid, nonce, commitment, context))) {
        throw new Error(`Invalid reveal from participant ${pid}`);
      }
    }

    const orderedNonces = context.participant_ids
      .slice()
      .sort()
      .map(pid => `${pid}:${revealedNonces[pid]}`)
      .join('|');
    const derivedSeed = await sha256(`RANDOM_SEED:${contextHash}:${orderedNonces}`);
    const unbiasedIndex = this.unbiasedSampleIndex(derivedSeed, context.card_count);
    const selectedRef = sourceHiddenRefs[unbiasedIndex];

    const receiptHash = await sha256(
      `RANDOM_RECEIPT:${contextHash}:${derivedSeed}:${unbiasedIndex}:${selectedRef.ref_id}:${selectedRef.epoch}`
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

  static async finalizeSelectionWithProvenance(
    context: RandomSelectionContext,
    commitments: Record<string, string>,
    revealedNonces: Record<string, string>,
    sourceHiddenRefs: CardRef[]
  ): Promise<{ receipt: RandomSelectionReceipt; resolved_selection: ResolvedSelection }> {
    const receipt = await this.finalizeSelection(context, commitments, revealedNonces, sourceHiddenRefs);
    return {
      receipt,
      resolved_selection: {
        selection_kind: 'VERIFIED_RANDOM',
        selected_card_refs: [receipt.selected_ref],
        source_zone_id: receipt.source_zone_id,
        workflow_id: receipt.workflow_id,
        parent_state_hash: receipt.parent_state_hash,
        evidence_ref: receipt.receipt_hash,
      },
    };
  }
}
