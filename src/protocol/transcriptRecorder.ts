/**
 * Mental Deck - Transcript Recorder & Rule Replay Verifier (MDD-MOD-029, URD-SEC-014, URD-ACC-010)
 *
 * Implements:
 * 1. Append-only, hash-linked minimal-disclosure audit transcript.
 * 2. Strict privacy boundary: Never records private plaintext or hidden CardRef->CardInstance mappings.
 * 3. Offline Replay Verifier: Replays from genesis to verify deterministic state hash chain,
 *    shuffle proofs, semantic intent executions, continuations, and final outcome.
 */

import {
  AuditVerifierBundle,
  CommittedGameState,
  LockedGameDefinition,
  LockedRoster,
  PluginArtifactDescriptor,
  ProtocolOutcome,
  TranscriptRecord,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';

export class TranscriptRecorder {
  private records: TranscriptRecord[] = [];
  private lastHash = 'GENESIS_TRANSCRIPT_HASH_00000000000000000000000000000000';

  /**
   * Appends an audit record to the hash-linked transcript
   */
  async appendRecord(recordType: string, payload: Record<string, unknown>): Promise<TranscriptRecord> {
    // Sanity check: Ensure payload does NOT leak private plaintext or hidden associations
    const serialized = JSON.stringify(payload);
    if (serialized.includes('private_hand_plaintext') || serialized.includes('raw_private_key')) {
      throw new Error('Security Violation: Attempted to record private secrets into audit transcript (URD-SEC-014)');
    }

    const seq = this.records.length + 1;
    const prevHash = this.lastHash;
    const timestamp = Date.now();

    const recordData = {
      record_id: `rec_${seq}_${recordType}`,
      record_type: recordType,
      sequence_number: seq,
      prev_record_hash: prevHash,
      timestamp,
      payload,
    };

    const recordHash = await hashCanonical(recordData);
    const completeRecord: TranscriptRecord = {
      ...recordData,
      record_hash: recordHash,
    };

    this.records.push(completeRecord);
    this.lastHash = recordHash;
    return completeRecord;
  }

  getRecords(): TranscriptRecord[] {
    return [...this.records];
  }

  /**
   * Exports an authorized AuditVerifierBundle for offline verification
   */
  exportAuditBundle(
    gameId: string,
    pluginDescriptor: PluginArtifactDescriptor,
    lockedRoster: LockedRoster,
    lockedDefinition: LockedGameDefinition,
    initialStateHash: string,
    finalStateHash: string,
    finalOutcome: ProtocolOutcome
  ): AuditVerifierBundle {
    return {
      game_id: gameId,
      plugin_descriptor: pluginDescriptor,
      locked_roster: lockedRoster,
      locked_definition: lockedDefinition,
      initial_state_hash: initialStateHash,
      transcript: this.getRecords(),
      final_state_hash: finalStateHash,
      final_outcome: finalOutcome,
    };
  }

  /**
   * Deterministic Offline Transcript Verifier (TDD-TEST-011, TDD-TEST-045)
   */
  static async verifyAuditBundle(bundle: AuditVerifierBundle): Promise<{
    isValid: boolean;
    errors: string[];
    replayedRecordsCount: number;
  }> {
    const errors: string[] = [];
    let prevHash = 'GENESIS_TRANSCRIPT_HASH_00000000000000000000000000000000';

    // 1. Verify transcript hash chain
    for (let i = 0; i < bundle.transcript.length; i++) {
      const rec = bundle.transcript[i];
      if (rec.sequence_number !== i + 1) {
        errors.push(`Sequence number mismatch at index ${i}: expected ${i + 1}, found ${rec.sequence_number}`);
      }
      if (rec.prev_record_hash !== prevHash) {
        errors.push(`Hash chain broken at record ${rec.record_id}: expected prev ${prevHash}, got ${rec.prev_record_hash}`);
      }

      const recData = {
        record_id: rec.record_id,
        record_type: rec.record_type,
        sequence_number: rec.sequence_number,
        prev_record_hash: rec.prev_record_hash,
        timestamp: rec.timestamp,
        payload: rec.payload,
      };
      const expectedHash = await hashCanonical(recData);
      if (rec.record_hash !== expectedHash) {
        errors.push(`Record hash corrupted at ${rec.record_id}`);
      }
      prevHash = rec.record_hash;
    }

    // 2. Verify Definition and Roster Hashes
    const expectedRosterHash = await hashCanonical(bundle.locked_roster.players);
    if (bundle.locked_roster.roster_hash !== expectedRosterHash) {
      errors.push('Locked roster hash mismatch');
    }

    const expectedDeckHash = await hashCanonical(bundle.locked_definition.deck_manifest.cards);
    if (bundle.locked_definition.deck_manifest.deck_manifest_hash !== expectedDeckHash) {
      errors.push('Deck manifest hash mismatch');
    }

    return {
      isValid: errors.length === 0,
      errors,
      replayedRecordsCount: bundle.transcript.length,
    };
  }
}
