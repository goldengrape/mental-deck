/**
 * Mental Deck - Atomic Transition Kernel (MDD-MOD-020, URD-OP-009, URD-INV-009)
 *
 * Implements:
 * 1. Simulates ordered sub-operations on a working state snapshot.
 * 2. Validates all generic invariant properties (Zone conservation, no dangling groups, ordering).
 * 3. All-or-Nothing: Emits exactly one CoreEventCandidate on full success; 0 commits on any error.
 * 4. Combines with GameTransitionPatch to produce atomic CommittedGameState(version + 1).
 */

import {
  CardGroup,
  CardRef,
  CommittedGameState,
  CoreEventCandidate,
  CoreOperation,
  DisclosureGrant,
  GameTransitionPatch,
  OperationPlan,
  PublicCardBinding,
  RandomSelectionReceipt,
  ResolvedSelection,
  SelectionSpec,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';
import { DeterministicSelectionResolver } from './selection';
import { ZoneManager } from './zoneManager';

export class AtomicTransitionKernel {
  /**
   * Simulates an entire OperationPlan against the current committed state
   */
  static async simulatePlan(
    baseState: CommittedGameState,
    zoneDefs: Record<string, ZoneDefinition>,
    plan: OperationPlan,
    expectedTotalN: number,
    actorPlayerId?: string,
    receiptsStore?: Map<string, RandomSelectionReceipt> | Record<string, RandomSelectionReceipt>,
    consumedReceipts?: Set<string>
  ): Promise<CoreEventCandidate> {
    // Deep clone working state
    const workingZones: Record<string, ZoneState> = JSON.parse(JSON.stringify(baseState.zone_states));
    const workingGroups: Record<string, CardGroup> = JSON.parse(JSON.stringify(baseState.groups));
    const workingPublicBindings: Record<string, PublicCardBinding> = JSON.parse(
      JSON.stringify(baseState.public_bindings)
    );
    const workingGrants: Record<string, DisclosureGrant> = JSON.parse(JSON.stringify(baseState.grants));
    const eventsSummary: string[] = [];

    // Helper to fetch receipt from map or object
    const getReceipt = (refId: string): RandomSelectionReceipt | undefined => {
      if (!receiptsStore) return undefined;
      if (receiptsStore instanceof Map) return receiptsStore.get(refId);
      return receiptsStore[refId];
    };

    // Execute each operation in order
    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      switch (op.op_type) {
        case 'MOVE': {
          const srcDef = zoneDefs[op.source_zone_id];
          const dstDef = zoneDefs[op.destination_zone_id];
          if (!srcDef || !dstDef) throw new Error(`Unknown zone in MOVE: ${op.source_zone_id} -> ${op.destination_zone_id}`);

          const srcState = workingZones[op.source_zone_id];
          let resolved: ResolvedSelection;

          if (op.resolved_selection) {
            resolved = op.resolved_selection;
          } else if (op.selection && (op.selection as any).selection_kind) {
            resolved = op.selection as unknown as ResolvedSelection;
          } else if (op.selection) {
            if (op.selection.type === 'RANDOM') {
              throw new Error(
                'SelectionSpec with type=RANDOM is not an authorized selection. Random selection must be resolved via MultipartyRandomIndexProtocol and submitted as a ResolvedSelection(VERIFIED_RANDOM) with a valid receipt (URD-INV-021, MDD-DATA-025).'
              );
            }
            resolved = await DeterministicSelectionResolver.resolveSelection(
              srcState,
              srcDef,
              op.selection,
              actorPlayerId,
              baseState.active_workflow_id || undefined,
              baseState.state_hash
            );
          } else {
            throw new Error('MOVE operation must specify selection or resolved_selection');
          }

          // Strict Provenance and Authorization checks (URD-INV-021, URD-ACC-024)
          if (resolved.selection_kind === 'VERIFIED_RANDOM') {
            if (!resolved.evidence_ref) {
              throw new Error('VERIFIED_RANDOM selection must include evidence_ref bound to a valid RandomSelectionReceipt.');
            }
            if (resolved.source_zone_id !== op.source_zone_id) {
              throw new Error(`VERIFIED_RANDOM source zone mismatch: expected ${resolved.source_zone_id}, got ${op.source_zone_id}`);
            }

            const receipt = getReceipt(resolved.evidence_ref);
            if (receipt) {
              if (receipt.source_zone_id !== op.source_zone_id) {
                throw new Error(`Receipt source_zone_id ${receipt.source_zone_id} does not match MOVE source ${op.source_zone_id}`);
              }
              if (resolved.workflow_id && receipt.workflow_id && receipt.workflow_id !== resolved.workflow_id) {
                throw new Error(`Receipt workflow_id mismatch: ${receipt.workflow_id} vs ${resolved.workflow_id}`);
              }
              if (resolved.parent_state_hash && receipt.parent_state_hash && receipt.parent_state_hash !== resolved.parent_state_hash) {
                throw new Error(`Receipt parent_state_hash mismatch: ${receipt.parent_state_hash} vs ${resolved.parent_state_hash}`);
              }
              const selectedRef = resolved.selected_card_refs?.[0] || resolved.selected_refs?.[0];
              if (selectedRef && receipt.selected_ref.ref_id !== selectedRef.ref_id) {
                throw new Error(`Receipt selected_ref ${receipt.selected_ref.ref_id} does not match ResolvedSelection card ${selectedRef.ref_id}`);
              }
            }

            if (consumedReceipts && consumedReceipts.has(resolved.evidence_ref)) {
              throw new Error(`RandomSelectionReceipt ${resolved.evidence_ref} has already been consumed in a prior commit (URD-INV-021).`);
            }
          } else if (resolved.selection_kind === 'BY_HANDLE') {
            // Verify caller authorization: caller must own the zone or zone must be public
            if (srcDef.default_visibility !== 'PUBLIC' && srcDef.owner_player_id !== actorPlayerId) {
              throw new Error(`Caller ${actorPlayerId} is not authorized to select BY_HANDLE on non-public zone ${srcDef.zone_id}`);
            }
          }

          const selected = resolved.selected_card_refs || resolved.selected_refs || [];
          if (selected.length === 0) {
            throw new Error(`MOVE operation resolved 0 cards from ${op.source_zone_id}`);
          }

          // Verify all cards exist in working source zone
          const srcCardMap = new Map(srcState.card_refs.map(r => [r.ref_id, r]));
          for (const card of selected) {
            if (!srcCardMap.has(card.ref_id)) {
              throw new Error(`CardRef ${card.ref_id} does not exist in source zone ${op.source_zone_id}`);
            }
          }

          await ZoneManager.applyMove(workingZones, op, selected, dstDef);
          eventsSummary.push(`Moved ${selected.length} card(s) from ${op.source_zone_id} to ${op.destination_zone_id}`);
          break;
        }

        case 'REVEAL_PUBLIC':
        case 'REVEAL_TO': {
          const grantId = `grant_${Date.now()}_${i}`;
          const isPublic = op.op_type === 'REVEAL_PUBLIC';
          workingGrants[grantId] = {
            grant_id: grantId,
            card_refs: op.card_refs,
            visibility: isPublic ? 'PUBLIC' : 'SELECTIVE',
            authorized_viewers: isPublic ? ['PUBLIC'] : op.viewers,
            workflow_id: `wf_${baseState.state_version}`,
            stage_id: `stage_${i}`,
            parent_state_hash: baseState.state_hash,
            status: 'PENDING_SHARES',
          };
          eventsSummary.push(`Revealed ${op.card_refs.length} card(s) (${isPublic ? 'PUBLIC' : op.viewers.join(',')})`);
          break;
        }

        case 'PEEK': {
          // PEEK modifies no zone memberships or order (URD-INV-011)
          const srcDef = zoneDefs[op.source_zone_id];
          const srcState = workingZones[op.source_zone_id];
          const resolved = await DeterministicSelectionResolver.resolveSelection(srcState, srcDef, op.selection, actorPlayerId);
          const peekedCount = (resolved.selected_card_refs || resolved.selected_refs || []).length;
          eventsSummary.push(`Peeked ${peekedCount} card(s) from ${op.source_zone_id} by ${op.viewers.join(',')}`);
          break;
        }

        case 'GROUP': {
          ZoneManager.applyGroup(workingGroups, workingZones, op);
          eventsSummary.push(`Formed group ${op.group_id} in ${op.zone_id} with ${op.card_refs.length} card(s)`);
          break;
        }

        case 'UNGROUP': {
          ZoneManager.applyUngroup(workingGroups, op);
          eventsSummary.push(`Ungrouped group ${op.group_id}`);
          break;
        }

        case 'SHUFFLE': {
          // In Core simulation, verify zone exists
          const zState = workingZones[op.zone_id];
          if (!zState) throw new Error(`Zone ${op.zone_id} not found for SHUFFLE`);
          eventsSummary.push(`Shuffled zone ${op.zone_id}`);
          break;
        }

        default:
          throw new Error(`Unsupported operation: ${(op as CoreOperation).op_type}`);
      }
    }

    // Verify all global invariants
    ZoneManager.validateGlobalInvariants(workingZones, workingGroups, expectedTotalN);

    const candidateHash = await sha256(
      `CANDIDATE:${baseState.state_hash}:${await hashCanonical(workingZones)}:${await hashCanonical(workingGroups)}`
    );

    return {
      base_state_hash: baseState.state_hash,
      simulated_zone_states: workingZones,
      simulated_groups: workingGroups,
      simulated_public_bindings: workingPublicBindings,
      simulated_grants: workingGrants,
      candidate_hash: candidateHash,
      events_summary: eventsSummary,
    };
  }

  /**
   * Atomically commits a valid CoreEventCandidate + GameTransitionPatch to produce next CommittedGameState
   */
  static async commitTransition(
    baseState: CommittedGameState,
    candidate: CoreEventCandidate,
    patch: GameTransitionPatch,
    actionSummary?: string
  ): Promise<CommittedGameState> {
    if (candidate.base_state_hash !== baseState.state_hash) {
      throw new Error(`Base state hash mismatch: candidate expected ${candidate.base_state_hash}, found ${baseState.state_hash}`);
    }

    const nextVersion = baseState.state_version + 1;
    const extensionHash = patch.next_extension_hash;

    const nextStateData = {
      state_version: nextVersion,
      prev_state_hash: baseState.state_hash,
      zone_states: candidate.simulated_zone_states,
      groups: candidate.simulated_groups,
      public_bindings: candidate.simulated_public_bindings,
      grants: candidate.simulated_grants,
      game_state_extension: patch.next_game_state_extension,
      game_state_extension_hash: extensionHash,
    };

    const nextStateHash = await hashCanonical(nextStateData);

    return {
      ...nextStateData,
      state_hash: nextStateHash,
      last_action_summary: actionSummary ?? candidate.events_summary.join('; '),
      active_workflow_id: null,
    };
  }
}
