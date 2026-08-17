/**
 * Mental Deck - Transcript Recorder & Integrity Verifier
 *
 * This module verifies the append-only transcript chain and locked artifact
 * commitments. It does NOT yet reconstruct every semantic transition from genesis,
 * so it must not be described as a full zero-knowledge protocol replay verifier.
 */

import {
  AuditVerifierBundle,
  LockedGameDefinition,
  LockedRoster,
  PluginArtifactDescriptor,
  ProtocolOutcome,
  TranscriptRecord,
} from '../types/contracts';
import { hashCanonical } from '../crypto/cryptoProvider';

const FORBIDDEN_SECRET_KEYS = new Set([
  'private_key',
  'raw_private_key',
  'signing_private_key',
  'encryption_private_key',
  'private_hand_plaintext',
  'card_ref_instance_map',
]);

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertNoSecretFields(value: unknown, path = 'payload'): void {
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertNoSecretFields(item, `${path}[${index}]`));
    return;
  }
  if (!value || typeof value !== 'object') return;

  for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_SECRET_KEYS.has(key.toLowerCase())) {
      throw new Error(
        `Security violation: audit transcript attempted to record secret field ${path}.${key}`
      );
    }
    assertNoSecretFields(child, `${path}.${key}`);
  }
}

export class TranscriptRecorder {
  private records: TranscriptRecord[] = [];
  private lastHash =
    'GENESIS_TRANSCRIPT_HASH_00000000000000000000000000000000';

  async appendRecord(
    recordType: string,
    payload: Record<string, unknown>
  ): Promise<TranscriptRecord> {
    assertNoSecretFields(payload);

    const sequenceNumber = this.records.length + 1;
    const previousHash = this.lastHash;
    const timestamp = Date.now();
    const recordData = {
      record_id: `rec_${sequenceNumber}_${recordType}`,
      record_type: recordType,
      sequence_number: sequenceNumber,
      prev_record_hash: previousHash,
      timestamp,
      payload: cloneJson(payload),
    };
    const recordHash = await hashCanonical(recordData);
    const completeRecord: TranscriptRecord = {
      ...recordData,
      record_hash: recordHash,
    };

    this.records.push(cloneJson(completeRecord));
    this.lastHash = recordHash;
    return cloneJson(completeRecord);
  }

  getRecords(): TranscriptRecord[] {
    return cloneJson(this.records);
  }

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
      plugin_descriptor: cloneJson(pluginDescriptor),
      locked_roster: cloneJson(lockedRoster),
      locked_definition: cloneJson(lockedDefinition),
      initial_state_hash: initialStateHash,
      transcript: this.getRecords(),
      final_state_hash: finalStateHash,
      final_outcome: cloneJson(finalOutcome),
    };
  }

  /**
   * Integrity verification scope:
   * 1. transcript sequence/hash chain;
   * 2. locked roster/deck/zones/allocation/definition commitments;
   * 3. initial/final state references recorded in the transcript;
   * 4. final outcome points at the exported final state.
   *
   * Semantic transition replay is intentionally not claimed here.
   */
  static async verifyAuditBundle(bundle: AuditVerifierBundle): Promise<{
    isValid: boolean;
    errors: string[];
    replayedRecordsCount: number;
    verificationScope: string;
  }> {
    const errors: string[] = [];
    let previousHash =
      'GENESIS_TRANSCRIPT_HASH_00000000000000000000000000000000';

    for (let index = 0; index < bundle.transcript.length; index++) {
      const record = bundle.transcript[index];
      if (record.sequence_number !== index + 1) {
        errors.push(
          `Sequence mismatch at index ${index}: expected ${index + 1}, found ${record.sequence_number}`
        );
      }
      if (record.prev_record_hash !== previousHash) {
        errors.push(`Transcript hash chain broken at ${record.record_id}`);
      }

      try {
        assertNoSecretFields(record.payload);
      } catch (error) {
        errors.push((error as Error).message);
      }

      const expectedRecordHash = await hashCanonical({
        record_id: record.record_id,
        record_type: record.record_type,
        sequence_number: record.sequence_number,
        prev_record_hash: record.prev_record_hash,
        timestamp: record.timestamp,
        payload: record.payload,
      });
      if (record.record_hash !== expectedRecordHash) {
        errors.push(`Record hash corrupted at ${record.record_id}`);
      }
      previousHash = record.record_hash;
    }

    const expectedRosterHash = await hashCanonical(bundle.locked_roster.players);
    if (bundle.locked_roster.roster_hash !== expectedRosterHash) {
      errors.push('Locked roster hash mismatch');
    }
    if (bundle.locked_definition.roster_hash !== bundle.locked_roster.roster_hash) {
      errors.push('Locked definition references a different roster hash');
    }

    const expectedDeckHash = await hashCanonical(
      bundle.locked_definition.deck_manifest.cards
    );
    if (
      bundle.locked_definition.deck_manifest.deck_manifest_hash !==
      expectedDeckHash
    ) {
      errors.push('Deck manifest hash mismatch');
    }

    const expectedZoneHash = await hashCanonical(
      bundle.locked_definition.zone_manifest.zones
    );
    if (
      bundle.locked_definition.zone_manifest.zone_manifest_hash !==
      expectedZoneHash
    ) {
      errors.push('Zone manifest hash mismatch');
    }

    const expectedPlanHash = await hashCanonical(
      bundle.locked_definition.initialization_plan.steps
    );
    if (
      bundle.locked_definition.initialization_plan.plan_hash !==
      expectedPlanHash
    ) {
      errors.push('Initialization plan hash mismatch');
    }

    const expectedDefinitionHash = await hashCanonical({
      plugin_descriptor: bundle.locked_definition.plugin_descriptor,
      roster_hash: bundle.locked_definition.roster_hash,
      deck_manifest: bundle.locked_definition.deck_manifest,
      zone_manifest: bundle.locked_definition.zone_manifest,
      initial_game_extension: bundle.locked_definition.initial_game_extension,
      initialization_plan: bundle.locked_definition.initialization_plan,
    });
    if (
      bundle.locked_definition.game_definition_hash !== expectedDefinitionHash
    ) {
      errors.push('Locked game definition hash mismatch');
    }

    if (
      bundle.plugin_descriptor.plugin_id !==
        bundle.locked_definition.plugin_descriptor.plugin_id ||
      bundle.plugin_descriptor.plugin_version !==
        bundle.locked_definition.plugin_descriptor.plugin_version ||
      bundle.plugin_descriptor.plugin_package_hash !==
        bundle.locked_definition.plugin_descriptor.plugin_package_hash
    ) {
      errors.push('Exported plugin descriptor does not match locked definition');
    }

    const allocationRecord = bundle.transcript.find(
      record => record.record_type === 'INITIAL_ALLOCATION_COMPLETED'
    );
    if (
      allocationRecord &&
      allocationRecord.payload.initial_state_hash !== bundle.initial_state_hash
    ) {
      errors.push('Initial state hash does not match transcript allocation record');
    }

    const committedStateRecords = bundle.transcript.filter(
      record => record.record_type === 'STATE_COMMITTED'
    );
    if (committedStateRecords.length > 0) {
      const lastCommitted = committedStateRecords[committedStateRecords.length - 1];
      if (lastCommitted.payload.state_hash !== bundle.final_state_hash) {
        errors.push('Final state hash does not match last committed-state transcript record');
      }
    }

    if (bundle.final_outcome.final_state_hash !== bundle.final_state_hash) {
      errors.push('Final outcome references a different final state hash');
    }

    return {
      isValid: errors.length === 0,
      errors,
      replayedRecordsCount: bundle.transcript.length,
      verificationScope:
        'hash-chain and locked-artifact integrity only; semantic protocol replay not yet implemented',
    };
  }
}
