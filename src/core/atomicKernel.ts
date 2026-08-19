/**
 * Mental Deck - Atomic Transition Kernel.
 *
 * Security boundary rules:
 * - Core consumes SelectionSpec only through deterministic resolvers.
 * - VERIFIED_RANDOM must carry an existing, exact-context, unconsumed receipt.
 * - Never coerce an arbitrary SelectionSpec/object into a trusted ResolvedSelection.
 * - BY_HANDLE on private zones requires owner/scoped controller authority.
 * - Transition extension hashes are recomputed on the legacy compatibility path.
 */

import {
  CardGroup,
  CommittedGameState,
  ControllerGrant,
  CoreEventCandidate,
  CoreOperation,
  DisclosureGrant,
  GameTransitionPatch,
  OperationPlan,
  PublicCardBinding,
  RandomSelectionReceipt,
  ResolvedSelection,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';
import { DeterministicSelectionResolver } from './selection';
import { ZoneManager } from './zoneManager';
import { ControllerEngine } from './controllerEngine';

function sameRef(a: { ref_id: string; epoch: number }, b: { ref_id: string; epoch: number }): boolean {
  return a.ref_id === b.ref_id && a.epoch === b.epoch;
}

export class AtomicTransitionKernel {
  static async simulatePlan(
    baseState: CommittedGameState,
    zoneDefs: Record<string, ZoneDefinition>,
    plan: OperationPlan,
    expectedTotalN: number,
    actorPlayerId?: string,
    receiptsStore?: Map<string, RandomSelectionReceipt> | Record<string, RandomSelectionReceipt>,
    consumedReceipts?: Set<string>,
    actionId?: string,
    rosterPlayerIds: string[] = []
  ): Promise<CoreEventCandidate> {
    const workingZones: Record<string, ZoneState> = JSON.parse(JSON.stringify(baseState.zone_states));
    const workingGroups: Record<string, CardGroup> = JSON.parse(JSON.stringify(baseState.groups));
    const workingPublicBindings: Record<string, PublicCardBinding> = JSON.parse(JSON.stringify(baseState.public_bindings));
    const workingGrants: Record<string, DisclosureGrant> = JSON.parse(JSON.stringify(baseState.disclosure_grants ?? baseState.grants ?? {}));
    const workingControllerGrants: Record<string, ControllerGrant> = JSON.parse(JSON.stringify(baseState.controller_grants ?? {}));
    const eventsSummary: string[] = [];

    const getReceipt = (receiptHash: string): RandomSelectionReceipt | undefined => {
      if (!receiptsStore) return undefined;
      if (receiptsStore instanceof Map) return receiptsStore.get(receiptHash);
      return receiptsStore[receiptHash];
    };

    for (let i = 0; i < plan.operations.length; i++) {
      const op = plan.operations[i];
      switch (op.op_type) {
        case 'MOVE': {
          const srcDef = zoneDefs[op.source_zone_id];
          const dstDef = zoneDefs[op.destination_zone_id];
          if (!srcDef || !dstDef) throw new Error(`Unknown zone in MOVE: ${op.source_zone_id} -> ${op.destination_zone_id}`);
          const srcState = workingZones[op.source_zone_id];
          if (!srcState) throw new Error(`Source zone ${op.source_zone_id} missing from state`);

          let resolved: ResolvedSelection;
          if (op.resolved_selection) {
            resolved = op.resolved_selection;
          } else if (op.selection) {
            if (op.selection.type === 'RANDOM') {
              throw new Error('SelectionSpec type=RANDOM is not authorization. Use ResolvedSelection(VERIFIED_RANDOM) with a valid receipt.');
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
            throw new Error(`ResolvedSelection source zone mismatch: ${resolved.source_zone_id} != ${op.source_zone_id}`);
          }

          if (resolved.selection_kind === 'VERIFIED_RANDOM') {
            if (!resolved.evidence_ref) throw new Error('VERIFIED_RANDOM requires evidence_ref for a RandomSelectionReceipt');
            if (!receiptsStore) throw new Error('VERIFIED_RANDOM requires a receipt store; fail-closed when evidence cannot be resolved');
            const receipt = getReceipt(resolved.evidence_ref);
            if (!receipt) throw new Error(`RandomSelectionReceipt ${resolved.evidence_ref} not found`);
            if (receipt.receipt_hash !== resolved.evidence_ref) throw new Error('RandomSelectionReceipt identity mismatch');
            if (receipt.source_zone_id !== op.source_zone_id) throw new Error(`Receipt source zone mismatch: ${receipt.source_zone_id} != ${op.source_zone_id}`);
            if (receipt.source_ref_set_commitment !== srcState.commitment_hash) throw new Error('Receipt source commitment no longer matches current source ZoneState');
            if (receipt.parent_state_hash !== baseState.state_hash) throw new Error('Receipt parent_state_hash does not match current base state');
            if (resolved.parent_state_hash !== receipt.parent_state_hash) throw new Error('ResolvedSelection parent_state_hash does not match receipt');
            if (resolved.workflow_id !== receipt.workflow_id) throw new Error('ResolvedSelection workflow_id does not match receipt');
            if (baseState.active_workflow_id && receipt.workflow_id !== baseState.active_workflow_id) throw new Error('Receipt workflow_id does not match active workflow');
            const selectedRefs = resolved.selected_card_refs ?? [];
            if (selectedRefs.length !== 1 || !sameRef(selectedRefs[0], receipt.selected_ref)) {
              throw new Error('Receipt selected_ref does not exactly match ResolvedSelection card and epoch');
            }
            if (consumedReceipts?.has(receipt.receipt_hash)) throw new Error(`RandomSelectionReceipt ${receipt.receipt_hash} has already been consumed`);
          } else if (resolved.selection_kind === 'BY_HANDLE') {
            const legacyAllowed = srcDef.default_visibility === 'PUBLIC' || srcDef.owner_player_id === actorPlayerId;
            const scopedAllowed = !!actorPlayerId && !!actionId && ControllerEngine.isController(
              { ...baseState, controller_grants: workingControllerGrants },
              srcDef,
              actorPlayerId,
              actionId,
              rosterPlayerIds
            );
            if (!legacyAllowed && !scopedAllowed) {
              throw new Error(`Caller ${actorPlayerId} is not authorized to select BY_HANDLE on zone ${srcDef.zone_id} for action ${actionId ?? '<legacy>'}`);
            }
          }

          const selected = resolved.selected_card_refs ?? [];
          if (selected.length === 0) throw new Error(`MOVE operation resolved 0 cards from ${op.source_zone_id}`);
          const srcCardMap = new Map(srcState.card_refs.map(r => [r.ref_id, r]));
          for (const card of selected) {
            const current = srcCardMap.get(card.ref_id);
            if (!current || current.epoch !== card.epoch) {
              throw new Error(`CardRef ${card.ref_id}@${card.epoch} does not exactly exist in source zone ${op.source_zone_id}`);
            }
          }

          await ZoneManager.applyMove(workingZones, op, selected, dstDef);
          eventsSummary.push(`Moved ${selected.length} card(s) from ${op.source_zone_id} to ${op.destination_zone_id}`);
          break;
        }

        case 'REVEAL_PUBLIC':
        case 'REVEAL_TO': {
          const grantId = `grant_${baseState.state_version + 1}_${i}`;
          const isPublic = op.op_type === 'REVEAL_PUBLIC';
          workingGrants[grantId] = {
            grant_id: grantId,
            card_refs: op.card_refs,
            visibility: isPublic ? 'PUBLIC' : 'SELECTIVE',
            authorized_viewers: isPublic ? ['PUBLIC'] : op.viewers,
            workflow_id: baseState.active_workflow_id || `wf_state_${baseState.state_version}`,
            stage_id: `stage_${i}`,
            parent_state_hash: baseState.state_hash,
            status: 'PENDING_SHARES',
          };
          eventsSummary.push(`Created disclosure grant for ${op.card_refs.length} card(s)`);
          break;
        }

        case 'PEEK': {
          const srcDef = zoneDefs[op.source_zone_id];
          const srcState = workingZones[op.source_zone_id];
          if (!srcDef || !srcState) throw new Error(`Unknown source zone ${op.source_zone_id} for PEEK`);
          if (!actorPlayerId || !actionId || !ControllerEngine.isController(baseState, srcDef, actorPlayerId, actionId, rosterPlayerIds)) {
            throw new Error(`Caller ${actorPlayerId} is not authorized to PEEK zone ${op.source_zone_id}`);
          }
          const resolved = await DeterministicSelectionResolver.resolveSelection(
            srcState,
            srcDef,
            op.selection,
            actorPlayerId,
            baseState.active_workflow_id || undefined,
            baseState.state_hash
          );
          eventsSummary.push(`Peek authorization created for ${resolved.selected_card_refs.length} card(s)`);
          break;
        }

        case 'GROUP':
          ZoneManager.applyGroup(workingGroups, workingZones, op);
          eventsSummary.push(`Formed group ${op.group_id}`);
          break;
        case 'UNGROUP':
          ZoneManager.applyUngroup(workingGroups, op);
          eventsSummary.push(`Ungrouped group ${op.group_id}`);
          break;
        case 'SHUFFLE':
          if (!workingZones[op.zone_id]) throw new Error(`Zone ${op.zone_id} not found for SHUFFLE`);
          eventsSummary.push(`Shuffle requested for zone ${op.zone_id}`);
          break;
        default:
          throw new Error(`Unsupported operation: ${(op as CoreOperation).op_type}`);
      }
    }

    ZoneManager.validateGlobalInvariants(workingZones, workingGroups, expectedTotalN);
    const candidateHash = await sha256(
      `CANDIDATE:${baseState.state_hash}:${await hashCanonical(workingZones)}:${await hashCanonical(workingGroups)}:${await hashCanonical(workingGrants)}:${await hashCanonical(workingControllerGrants)}`
    );

    return {
      base_state_hash: baseState.state_hash,
      simulated_zone_states: workingZones,
      simulated_groups: workingGroups,
      simulated_public_bindings: workingPublicBindings,
      simulated_grants: workingGrants,
      simulated_controller_grants: workingControllerGrants,
      candidate_hash: candidateHash,
      events_summary: eventsSummary,
    };
  }

  /** Legacy v0.9 compatibility commit. Generic v0.10 coordination uses transition commitments instead. */
  static async commitTransition(
    baseState: CommittedGameState,
    candidate: CoreEventCandidate,
    patch: GameTransitionPatch,
    actionSummary?: string
  ): Promise<CommittedGameState> {
    if (candidate.base_state_hash !== baseState.state_hash) {
      throw new Error(`Base state hash mismatch: candidate expected ${candidate.base_state_hash}, found ${baseState.state_hash}`);
    }
    const computedExtensionHash = await hashCanonical(patch.next_game_state_extension);
    if (patch.next_extension_hash !== computedExtensionHash) throw new Error('GameTransitionPatch extension hash mismatch');

    const nextVersion = baseState.state_version + 1;
    const nextStateData = {
      state_version: nextVersion,
      prev_state_hash: baseState.state_hash,
      zone_states: candidate.simulated_zone_states,
      groups: candidate.simulated_groups,
      public_bindings: candidate.simulated_public_bindings,
      grants: candidate.simulated_grants,
      disclosure_grants: candidate.simulated_grants,
      controller_grants: candidate.simulated_controller_grants ?? baseState.controller_grants ?? {},
      game_state_extension: patch.next_game_state_extension,
      game_state_extension_hash: computedExtensionHash,
    };
    const nextStateHash = await hashCanonical(nextStateData);
    return {
      ...nextStateData,
      state_hash: nextStateHash,
      last_action_summary: actionSummary ?? candidate.events_summary.join('; '),
      active_workflow_id: baseState.active_workflow_id ?? null,
    };
  }
}
