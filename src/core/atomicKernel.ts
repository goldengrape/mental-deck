/**
 * Mental Deck - Atomic Transition Kernel
 *
 * Security properties enforced here:
 * - deterministic selections are always resolved inside the kernel;
 * - externally supplied ResolvedSelection is accepted only for VERIFIED_RANDOM;
 * - random receipts must exist, bind the current source commitment/state/workflow,
 *   verify completely, and be one-time consumable;
 * - candidate hashes cover every state-bearing field and are rechecked at commit;
 * - extension hashes are rechecked at commit;
 * - generic private-zone reveal/peek operations require source authorization.
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
  RandomSelectionContext,
  RandomSelectionReceipt,
  ResolvedSelection,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';
import { MultipartyRandomIndexProtocol } from '../crypto/randomIndex';
import { DeterministicSelectionResolver } from './selection';
import { ZoneManager } from './zoneManager';

function cloneJson<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

function assertAuthorizedForPrivateZone(
  zoneDef: ZoneDefinition,
  actorPlayerId: string | undefined,
  operationName: string
): void {
  if (zoneDef.default_visibility === 'PUBLIC') return;
  if (zoneDef.owner_player_id && zoneDef.owner_player_id === actorPlayerId) return;
  throw new Error(
    `${operationName} is not authorized on non-public zone ${zoneDef.zone_id} for actor ${actorPlayerId ?? '<none>'}`
  );
}

function findZoneContainingRef(
  workingZones: Record<string, ZoneState>,
  ref: CardRef
): string | null {
  for (const [zoneId, zoneState] of Object.entries(workingZones)) {
    if (zoneState.card_refs.some(candidate => candidate.ref_id === ref.ref_id)) {
      return zoneId;
    }
  }
  return null;
}

export class AtomicTransitionKernel {
  private static async computeCandidateHash(
    candidate: Omit<CoreEventCandidate, 'candidate_hash'> & { candidate_hash?: string }
  ): Promise<string> {
    return hashCanonical({
      base_state_hash: candidate.base_state_hash,
      simulated_zone_states: candidate.simulated_zone_states,
      simulated_groups: candidate.simulated_groups,
      simulated_public_bindings: candidate.simulated_public_bindings,
      simulated_grants: candidate.simulated_grants,
      events_summary: candidate.events_summary,
    });
  }

  /**
   * Re-seal a candidate after an authorized coordinator-side disclosure binding
   * has been attached. This should be rare; normal operations should build all
   * state changes inside simulatePlan.
   */
  static async resealCandidate(candidate: CoreEventCandidate): Promise<void> {
    candidate.candidate_hash = await this.computeCandidateHash(candidate);
  }

  /**
   * Build a read-only projected post-operation state for deterministic plugin
   * reduction. Version/hash remain those of the base state because no commit has
   * occurred yet; zone/group/binding/grant fields reflect the candidate.
   */
  static projectCandidateState(
    baseState: CommittedGameState,
    candidate: CoreEventCandidate
  ): CommittedGameState {
    return {
      ...cloneJson(baseState),
      zone_states: cloneJson(candidate.simulated_zone_states),
      groups: cloneJson(candidate.simulated_groups),
      public_bindings: cloneJson(candidate.simulated_public_bindings),
      grants: cloneJson(candidate.simulated_grants),
    };
  }

  static async simulatePlan(
    baseState: CommittedGameState,
    zoneDefs: Record<string, ZoneDefinition>,
    plan: OperationPlan,
    expectedTotalN: number,
    actorPlayerId?: string,
    receiptsStore?: Map<string, RandomSelectionReceipt> | Record<string, RandomSelectionReceipt>,
    consumedReceipts?: Set<string>
  ): Promise<CoreEventCandidate> {
    if (!plan.is_atomic) {
      throw new Error('AtomicTransitionKernel accepts only is_atomic=true plans.');
    }

    const workingZones = cloneJson(baseState.zone_states);
    const workingGroups = cloneJson(baseState.groups);
    const workingPublicBindings = cloneJson(baseState.public_bindings);
    const workingGrants = cloneJson(baseState.grants);
    const eventsSummary: string[] = [];

    const getReceipt = (refId: string): RandomSelectionReceipt | undefined => {
      if (!receiptsStore) return undefined;
      if (receiptsStore instanceof Map) return receiptsStore.get(refId);
      return receiptsStore[refId];
    };

    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];

      switch (op.op_type) {
        case 'MOVE': {
          const srcDef = zoneDefs[op.source_zone_id];
          const dstDef = zoneDefs[op.destination_zone_id];
          const srcState = workingZones[op.source_zone_id];
          if (!srcDef || !dstDef || !srcState) {
            throw new Error(
              `Unknown zone in MOVE: ${op.source_zone_id} -> ${op.destination_zone_id}`
            );
          }

          let resolved: ResolvedSelection;

          if (op.resolved_selection) {
            if (op.resolved_selection.selection_kind !== 'VERIFIED_RANDOM') {
              throw new Error(
                `External resolved_selection kind ${op.resolved_selection.selection_kind} is forbidden. ` +
                  'TOP/BOTTOM/ALL/BY_HANDLE must be resolved inside the kernel.'
              );
            }
            resolved = op.resolved_selection;
          } else if (op.selection) {
            if (op.selection.type === 'RANDOM') {
              throw new Error(
                'SelectionSpec type=RANDOM is not authorized. Random selection must arrive as VERIFIED_RANDOM with a receipt.'
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

          if (resolved.source_zone_id !== op.source_zone_id) {
            throw new Error(
              `ResolvedSelection source zone mismatch: selection=${resolved.source_zone_id}, move=${op.source_zone_id}`
            );
          }

          if (resolved.selection_kind === 'VERIFIED_RANDOM') {
            if (!resolved.evidence_ref) {
              throw new Error('VERIFIED_RANDOM selection requires evidence_ref.');
            }
            if (!receiptsStore || !consumedReceipts) {
              throw new Error(
                'VERIFIED_RANDOM requires both a receipt store and consumed-receipt set.'
              );
            }
            if (consumedReceipts.has(resolved.evidence_ref)) {
              throw new Error(
                `RandomSelectionReceipt ${resolved.evidence_ref} has already been consumed.`
              );
            }

            const receipt = getReceipt(resolved.evidence_ref);
            if (!receipt) {
              throw new Error(
                `RandomSelectionReceipt ${resolved.evidence_ref} was not found in the authoritative receipt store.`
              );
            }
            if (receipt.receipt_hash !== resolved.evidence_ref) {
              throw new Error('RandomSelectionReceipt hash does not match evidence_ref.');
            }
            if (receipt.source_zone_id !== op.source_zone_id) {
              throw new Error('RandomSelectionReceipt source zone mismatch.');
            }
            if (receipt.parent_state_hash !== baseState.state_hash) {
              throw new Error('RandomSelectionReceipt parent state does not match current base state.');
            }
            if (receipt.source_ref_set_commitment !== srcState.commitment_hash) {
              throw new Error(
                'RandomSelectionReceipt source commitment does not match the current source zone.'
              );
            }
            if (resolved.workflow_id !== receipt.workflow_id) {
              throw new Error('RandomSelectionReceipt workflow_id mismatch.');
            }
            if (resolved.parent_state_hash !== receipt.parent_state_hash) {
              throw new Error('ResolvedSelection parent_state_hash mismatch.');
            }

            const selected = resolved.selected_card_refs || resolved.selected_refs || [];
            if (selected.length !== 1) {
              throw new Error('VERIFIED_RANDOM currently requires exactly one selected card.');
            }
            if (
              selected[0].ref_id !== receipt.selected_ref.ref_id ||
              selected[0].epoch !== receipt.selected_ref.epoch
            ) {
              throw new Error(
                `Receipt selected_ref ${receipt.selected_ref.ref_id} does not match ResolvedSelection card ${selected[0].ref_id}`
              );
            }

            const participantIds = Object.keys(receipt.commitments);
            const reconstructedContext: RandomSelectionContext = {
              workflow_id: receipt.workflow_id,
              parent_state_hash: receipt.parent_state_hash,
              source_zone_id: receipt.source_zone_id,
              source_ref_set_commitment: receipt.source_ref_set_commitment,
              card_count: srcState.card_refs.length,
              participant_ids: participantIds,
              round: 1,
            };

            const receiptValid = await MultipartyRandomIndexProtocol.verifyReceipt(
              receipt,
              reconstructedContext,
              srcState.card_refs
            );
            if (!receiptValid) {
              throw new Error('RandomSelectionReceipt failed full verification.');
            }
          } else if (resolved.selection_kind === 'BY_HANDLE') {
            // Defense in depth: resolver already performs the same ACL check.
            assertAuthorizedForPrivateZone(srcDef, actorPlayerId, 'BY_HANDLE');
          }

          const selected = resolved.selected_card_refs || resolved.selected_refs || [];
          if (selected.length === 0) {
            throw new Error(`MOVE resolved 0 cards from ${op.source_zone_id}`);
          }

          const srcCardMap = new Map(srcState.card_refs.map(ref => [ref.ref_id, ref]));
          const seenSelected = new Set<string>();
          for (const card of selected) {
            if (seenSelected.has(card.ref_id)) {
              throw new Error(`Duplicate CardRef ${card.ref_id} in resolved selection.`);
            }
            seenSelected.add(card.ref_id);
            const sourceCard = srcCardMap.get(card.ref_id);
            if (!sourceCard || sourceCard.epoch !== card.epoch) {
              throw new Error(
                `CardRef ${card.ref_id}@${card.epoch} does not exist in source zone ${op.source_zone_id}`
              );
            }
          }

          await ZoneManager.applyMove(workingZones, op, selected, dstDef);
          eventsSummary.push(
            `Moved ${selected.length} card(s) from ${op.source_zone_id} to ${op.destination_zone_id}`
          );
          break;
        }

        case 'REVEAL_PUBLIC':
        case 'REVEAL_TO': {
          if (op.card_refs.length === 0) {
            throw new Error(`${op.op_type} requires at least one CardRef.`);
          }

          for (const cardRef of op.card_refs) {
            const sourceZoneId = findZoneContainingRef(workingZones, cardRef);
            if (!sourceZoneId) {
              throw new Error(`Cannot reveal unknown CardRef ${cardRef.ref_id}.`);
            }
            const sourceDef = zoneDefs[sourceZoneId];
            if (!sourceDef) {
              throw new Error(`Zone definition ${sourceZoneId} not found for reveal.`);
            }
            assertAuthorizedForPrivateZone(sourceDef, actorPlayerId, op.op_type);
          }

          const workflowId = baseState.active_workflow_id || plan.plan_hash;
          const grantDigest = await sha256(
            `GRANT_V1:${baseState.state_hash}:${workflowId}:${i}:${op.op_type}:${op.card_refs
              .map(ref => `${ref.ref_id}@${ref.epoch}`)
              .join(',')}`
          );
          const grantId = `grant_${grantDigest.slice(0, 20)}`;
          const isPublic = op.op_type === 'REVEAL_PUBLIC';
          workingGrants[grantId] = {
            grant_id: grantId,
            card_refs: cloneJson(op.card_refs),
            visibility: isPublic ? 'PUBLIC' : 'SELECTIVE',
            authorized_viewers: isPublic ? ['PUBLIC'] : [...op.viewers],
            workflow_id: workflowId,
            stage_id: `stage_${i}`,
            parent_state_hash: baseState.state_hash,
            status: 'PENDING_SHARES',
          };
          eventsSummary.push(
            `Revealed ${op.card_refs.length} card(s) (${isPublic ? 'PUBLIC' : op.viewers.join(',')})`
          );
          break;
        }

        case 'PEEK': {
          const srcDef = zoneDefs[op.source_zone_id];
          const srcState = workingZones[op.source_zone_id];
          if (!srcDef || !srcState) {
            throw new Error(`Unknown source zone ${op.source_zone_id} for PEEK.`);
          }
          assertAuthorizedForPrivateZone(srcDef, actorPlayerId, 'PEEK');
          const resolved = await DeterministicSelectionResolver.resolveSelection(
            srcState,
            srcDef,
            op.selection,
            actorPlayerId,
            baseState.active_workflow_id || undefined,
            baseState.state_hash
          );
          const peekedCount = resolved.selected_card_refs.length;
          eventsSummary.push(
            `Peeked ${peekedCount} card(s) from ${op.source_zone_id} by ${op.viewers.join(',')}`
          );
          break;
        }

        case 'GROUP': {
          if (workingGroups[op.group_id]) {
            throw new Error(`Group ${op.group_id} already exists.`);
          }
          ZoneManager.applyGroup(workingGroups, workingZones, op);
          eventsSummary.push(
            `Formed group ${op.group_id} in ${op.zone_id} with ${op.card_refs.length} card(s)`
          );
          break;
        }

        case 'UNGROUP': {
          ZoneManager.applyUngroup(workingGroups, op);
          eventsSummary.push(`Ungrouped group ${op.group_id}`);
          break;
        }

        case 'SHUFFLE': {
          throw new Error(
            'Generic SHUFFLE is not executed by AtomicTransitionKernel. Use the verified shuffle protocol and commit its resulting state explicitly.'
          );
        }

        default:
          throw new Error(`Unsupported operation: ${(op as CoreOperation).op_type}`);
      }
    }

    ZoneManager.validateGlobalInvariants(
      workingZones,
      workingGroups,
      expectedTotalN
    );

    const candidate: CoreEventCandidate = {
      base_state_hash: baseState.state_hash,
      simulated_zone_states: workingZones,
      simulated_groups: workingGroups,
      simulated_public_bindings: workingPublicBindings,
      simulated_grants: workingGrants,
      candidate_hash: '',
      events_summary: eventsSummary,
    };
    candidate.candidate_hash = await this.computeCandidateHash(candidate);
    return candidate;
  }

  static async commitTransition(
    baseState: CommittedGameState,
    candidate: CoreEventCandidate,
    patch: GameTransitionPatch,
    actionSummary?: string
  ): Promise<CommittedGameState> {
    if (candidate.base_state_hash !== baseState.state_hash) {
      throw new Error(
        `Base state hash mismatch: candidate expected ${candidate.base_state_hash}, found ${baseState.state_hash}`
      );
    }

    const expectedCandidateHash = await this.computeCandidateHash(candidate);
    if (candidate.candidate_hash !== expectedCandidateHash) {
      throw new Error('CoreEventCandidate integrity check failed; candidate was modified without resealing.');
    }

    const expectedExtensionHash = await hashCanonical(
      patch.next_game_state_extension
    );
    if (patch.next_extension_hash !== expectedExtensionHash) {
      throw new Error('GameTransitionPatch extension hash mismatch.');
    }

    const nextVersion = baseState.state_version + 1;
    const nextStateData = {
      state_version: nextVersion,
      prev_state_hash: baseState.state_hash,
      zone_states: cloneJson(candidate.simulated_zone_states),
      groups: cloneJson(candidate.simulated_groups),
      public_bindings: cloneJson(candidate.simulated_public_bindings),
      grants: cloneJson(candidate.simulated_grants),
      game_state_extension: cloneJson(patch.next_game_state_extension),
      game_state_extension_hash: expectedExtensionHash,
    };

    const nextStateHash = await hashCanonical(nextStateData);
    return {
      ...nextStateData,
      state_hash: nextStateHash,
      last_action_summary:
        actionSummary ?? candidate.events_summary.join('; '),
      active_workflow_id: null,
    };
  }
}
