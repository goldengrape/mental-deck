/**
 * Mental Deck - Zone & Operations Planner (MDD-MOD-017, MDD-MOD-018, MDD-MOD-019)
 *
 * Implements:
 * 1. MOVE Planning (Zone conservation, placement at TOP/BOTTOM).
 * 2. REVEAL / PEEK Planning (PEEK never moves cards).
 * 3. GROUP / UNGROUP Planning (Relation changes only, no dangling refs).
 * 4. Zone conservation validation: Total card count N is strictly conserved across all zones.
 */

import {
  CardGroup,
  CardRef,
  CommittedGameState,
  GroupOperation,
  MoveOperation,
  PeekOperation,
  PublicCardBinding,
  RevealOperation,
  UngroupOperation,
  ZoneDefinition,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';

export class ZoneManager {
  /**
   * Validates global Zone invariants on a working state:
   * P1: Sum of cards across all zones equals total N
   * P2: Every CardRef belongs to exactly one Zone
   * P3: No dangling references in any CardGroup
   */
  static validateGlobalInvariants(
    zoneStates: Record<string, ZoneState>,
    groups: Record<string, CardGroup>,
    expectedTotalN: number
  ): void {
    const seenRefs = new Set<string>();
    let totalCount = 0;

    for (const [zoneId, zState] of Object.entries(zoneStates)) {
      for (const cardRef of zState.card_refs) {
        if (seenRefs.has(cardRef.ref_id)) {
          throw new Error(`Invariant Violation (P2): CardRef ${cardRef.ref_id} found in multiple zones (including ${zoneId})`);
        }
        seenRefs.add(cardRef.ref_id);
        totalCount++;
      }
    }

    if (totalCount !== expectedTotalN) {
      throw new Error(`Invariant Violation (P1): Total cards count mismatch. Found ${totalCount}, expected ${expectedTotalN}`);
    }

    // Check Groups
    for (const [groupId, group] of Object.entries(groups)) {
      const zState = zoneStates[group.zone_id];
      if (!zState) {
        throw new Error(`Invariant Violation (P3): Group ${groupId} references non-existent zone ${group.zone_id}`);
      }
      const zoneRefIds = new Set(zState.card_refs.map(r => r.ref_id));
      for (const mRef of group.member_refs) {
        if (!zoneRefIds.has(mRef.ref_id)) {
          throw new Error(`Invariant Violation (P3): Group ${groupId} has dangling member ref ${mRef.ref_id} not in zone ${group.zone_id}`);
        }
      }
    }
  }

  /**
   * Applies MOVE operation to working ZoneStates
   */
  static async applyMove(
    workingZones: Record<string, ZoneState>,
    op: MoveOperation,
    selectedRefs: CardRef[],
    destZoneDef: ZoneDefinition
  ): Promise<void> {
    const src = workingZones[op.source_zone_id];
    const dst = workingZones[op.destination_zone_id];
    if (!src || !dst) {
      throw new Error(`Source (${op.source_zone_id}) or Destination (${op.destination_zone_id}) zone not found`);
    }

    const selectedSet = new Set(selectedRefs.map(r => r.ref_id));
    // Remove from source
    const newSrcRefs = src.card_refs.filter(r => !selectedSet.has(r.ref_id));
    if (newSrcRefs.length + selectedRefs.length !== src.card_refs.length) {
      throw new Error('Not all selected refs were present in source zone');
    }

    // Add to destination
    let newDstRefs: CardRef[] = [];
    if (destZoneDef.ordering === 'ORDERED') {
      if (op.placement === 'TOP') {
        newDstRefs = [...selectedRefs, ...dst.card_refs];
      } else {
        newDstRefs = [...dst.card_refs, ...selectedRefs];
      }
    } else {
      newDstRefs = [...dst.card_refs, ...selectedRefs];
    }

    const srcHash = await hashCanonical(newSrcRefs);
    const dstHash = await hashCanonical(newDstRefs);

    workingZones[op.source_zone_id] = {
      ...src,
      card_refs: newSrcRefs,
      commitment_hash: srcHash,
    };
    workingZones[op.destination_zone_id] = {
      ...dst,
      card_refs: newDstRefs,
      commitment_hash: dstHash,
    };
  }

  /**
   * Applies GROUP operation
   */
  static applyGroup(
    workingGroups: Record<string, CardGroup>,
    workingZones: Record<string, ZoneState>,
    op: GroupOperation
  ): void {
    const zState = workingZones[op.zone_id];
    if (!zState) throw new Error(`Zone ${op.zone_id} not found for group creation`);
    const zRefIds = new Set(zState.card_refs.map(r => r.ref_id));

    for (const ref of op.card_refs) {
      if (!zRefIds.has(ref.ref_id)) {
        throw new Error(`CardRef ${ref.ref_id} does not exist in zone ${op.zone_id} to form group ${op.group_id}`);
      }
    }

    workingGroups[op.group_id] = {
      group_id: op.group_id,
      zone_id: op.zone_id,
      member_refs: op.card_refs,
      label: op.label,
    };
  }

  /**
   * Applies UNGROUP operation
   */
  static applyUngroup(
    workingGroups: Record<string, CardGroup>,
    op: UngroupOperation
  ): void {
    if (!workingGroups[op.group_id]) {
      throw new Error(`Group ${op.group_id} not found to ungroup`);
    }
    delete workingGroups[op.group_id];
  }
}
