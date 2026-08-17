/**
 * Mental Deck - Deterministic Selection Resolver (MDD-MOD-014, URD-OP-002)
 *
 * Resolves TOP, BOTTOM, BY_HANDLE, ALL selections deterministically on a Zone.
 */

import {
  CardRef,
  ResolvedSelection,
  ResolvedSelectionKind,
  SelectionSpec,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';

export class DeterministicSelectionResolver {
  static async resolveSelection(
    zoneState: ZoneState,
    zoneDef: ZoneDefinition,
    spec: SelectionSpec,
    callerPlayerId?: string,
    workflowId?: string,
    parentStateHash?: string
  ): Promise<ResolvedSelection> {
    const refs = zoneState.card_refs;
    let selectedRefs: CardRef[] = [];
    let kind: ResolvedSelectionKind = 'ALL';

    switch (spec.type) {
      case 'TOP': {
        kind = 'TOP';
        if (zoneDef.ordering !== 'ORDERED') {
          throw new Error(`TOP selection is only valid for ORDERED zones. Zone ${zoneDef.zone_id} is ${zoneDef.ordering}.`);
        }
        const count = spec.count ?? 1;
        if (count > refs.length) {
          throw new Error(`Cannot select TOP(${count}) from zone with only ${refs.length} cards.`);
        }
        selectedRefs = refs.slice(0, count);
        break;
      }
      case 'BOTTOM': {
        kind = 'BOTTOM';
        if (zoneDef.ordering !== 'ORDERED') {
          throw new Error(`BOTTOM selection is only valid for ORDERED zones. Zone ${zoneDef.zone_id} is ${zoneDef.ordering}.`);
        }
        const count = spec.count ?? 1;
        if (count > refs.length) {
          throw new Error(`Cannot select BOTTOM(${count}) from zone with only ${refs.length} cards.`);
        }
        selectedRefs = refs.slice(refs.length - count);
        break;
      }
      case 'ALL': {
        kind = 'ALL';
        selectedRefs = [...refs];
        break;
      }
      case 'BY_HANDLE': {
        kind = 'BY_HANDLE';
        if (!spec.card_refs || spec.card_refs.length === 0) {
          throw new Error('BY_HANDLE selection requires explicit card_refs array.');
        }
        // Verify caller authorization: caller must own the zone or zone must be public
        if (zoneDef.default_visibility !== 'PUBLIC' && zoneDef.owner_player_id !== callerPlayerId) {
          throw new Error(`Caller ${callerPlayerId} is not authorized to select BY_HANDLE on non-public zone ${zoneDef.zone_id}`);
        }
        // Verify all requested refs exist in zone
        const refMap = new Map(refs.map(r => [r.ref_id, r]));
        for (const target of spec.card_refs) {
          const found = refMap.get(target.ref_id);
          if (!found) {
            throw new Error(`CardRef ${target.ref_id} does not exist in zone ${zoneDef.zone_id}`);
          }
          selectedRefs.push(found);
        }
        break;
      }
      case 'RANDOM': {
        throw new Error('RANDOM selection must be resolved via MultipartyRandomIndexProtocol, not deterministic resolver.');
      }
      default:
        throw new Error(`Unknown selection type: ${(spec as SelectionSpec).type}`);
    }

    const evidenceHash = await sha256(
      `SEL_EVID:${zoneDef.zone_id}:${await hashCanonical(spec)}:${selectedRefs.map(r => r.ref_id).join(',')}`
    );

    return {
      selection_kind: kind,
      selected_card_refs: selectedRefs,
      selected_refs: selectedRefs,
      source_zone_id: zoneDef.zone_id,
      workflow_id: workflowId,
      parent_state_hash: parentStateHash,
      evidence_ref: evidenceHash,
      evidence_hash: evidenceHash,
    };
  }
}
