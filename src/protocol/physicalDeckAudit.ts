import type {
  LockedRoster,
  LockedSecurityDefinition,
  StateTransitionRecord,
} from '../types/contracts';
import { StateLedger } from '../core/stateLedger';

export interface PhysicalDeckAuditBundle {
  audit_version: 'mental-deck-audit/v0.10';
  game_id: string;
  package_release_hash: string;
  security_definition_hash: string;
  roster_hash: string;
  initial_state_hash: string;
  final_state_hash: string;
  final_state_version: number;
  final_zone_commitments: Record<string, string>;
  transitions: StateTransitionRecord[];
}

/**
 * Exports only the public/minimal-disclosure transition stream plus state commitments.
 * It intentionally excludes private CardRef vectors, plaintext mappings, local knowledge,
 * private keys and Rule Advisor outputs.
 */
export function exportPhysicalDeckAuditBundle(
  gameId: string,
  definition: LockedSecurityDefinition,
  roster: LockedRoster,
  ledger: StateLedger
): PhysicalDeckAuditBundle {
  const snapshots = ledger.getAllSnapshots();
  if (snapshots.length === 0) throw new Error('Cannot export audit bundle from empty ledger');
  const initial = snapshots[0];
  const final = ledger.current;
  const finalZoneCommitments = Object.fromEntries(
    Object.entries(final.zone_states).map(([zoneId, zone]) => [zoneId, zone.commitment_hash])
  );
  const bundle: PhysicalDeckAuditBundle = {
    audit_version: 'mental-deck-audit/v0.10',
    game_id: gameId,
    package_release_hash: definition.package_release_hash,
    security_definition_hash: definition.security_definition_hash,
    roster_hash: roster.roster_hash,
    initial_state_hash: initial.state_hash,
    final_state_hash: final.state_hash,
    final_state_version: final.state_version,
    final_zone_commitments: finalZoneCommitments,
    transitions: ledger.getTransitionStream(),
  };
  assertAuditBundleMinimalDisclosure(bundle);
  return bundle;
}

export function verifyPhysicalDeckAuditEnvelope(bundle: PhysicalDeckAuditBundle): void {
  if (bundle.audit_version !== 'mental-deck-audit/v0.10') throw new Error('Unsupported audit bundle version');
  if (bundle.final_state_version !== bundle.transitions.length) {
    throw new Error('Audit transition count does not match final state_version');
  }

  let expectedBase = bundle.initial_state_hash;
  let expectedVersion = 1;
  for (const transition of bundle.transitions) {
    if (transition.state_version !== expectedVersion) throw new Error(`Audit transition version gap at ${expectedVersion}`);
    if (transition.base_state_hash !== expectedBase) throw new Error(`Audit state-hash chain mismatch at version ${expectedVersion}`);
    if (transition.base_state_version !== expectedVersion - 1) throw new Error(`Audit base_state_version mismatch at version ${expectedVersion}`);
    if (!transition.transition_commitment || !transition.public_payload_hash) throw new Error(`Audit transition ${expectedVersion} missing commitment`);
    expectedBase = transition.resulting_state_hash;
    expectedVersion++;
  }
  if (expectedBase !== bundle.final_state_hash) throw new Error('Audit final state hash does not match transition chain');
  assertAuditBundleMinimalDisclosure(bundle);
}

export function assertAuditBundleMinimalDisclosure(bundle: PhysicalDeckAuditBundle): void {
  const forbiddenKeys = new Set([
    'private_key',
    'signing_private_key',
    'encryption_private_key',
    'private_plaintext',
    'simulationCardRefInstanceMap',
    'card_ref_instance_map',
    'local_knowledge',
    'derived_rule_view_hash',
  ]);

  const visit = (value: unknown, path: string): void => {
    if (Array.isArray(value)) {
      value.forEach((entry, index) => visit(entry, `${path}[${index}]`));
      return;
    }
    if (!value || typeof value !== 'object') return;
    const record = value as Record<string, unknown>;
    if (typeof record.ref_id === 'string' && Number.isInteger(record.epoch)) {
      throw new Error(`Audit bundle exposes stable CardRef at ${path}`);
    }
    for (const [key, child] of Object.entries(record)) {
      if (forbiddenKeys.has(key)) throw new Error(`Audit bundle exposes forbidden field ${path}.${key}`);
      visit(child, `${path}.${key}`);
    }
  };

  visit(bundle.transitions, 'transitions');
}
