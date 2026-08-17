/**
 * Mental Deck - Local Knowledge Store (MDD-MOD-024, URD-ZONE-004, URD-INV-012)
 *
 * Implements:
 * 1. Tracks all authorized plaintext card facts learned by a specific player.
 * 2. Irreversible knowledge: once learned, a card fact CANNOT be revoked by subsequent moves or shuffles.
 * 3. Client-local only: strictly never uploaded to the coordinator server.
 */

import { CardInstance, LocalKnowledgeRecord } from '../types/contracts';

export class LocalKnowledgeStore {
  private records: Map<string, LocalKnowledgeRecord> = new Map(); // card_ref_id -> record
  private instanceToRef: Map<string, string> = new Map(); // card_instance_id -> card_ref_id

  constructor(public readonly playerId: string, public readonly gameId: string) {}

  /**
   * Record authorized plaintext knowledge learned at a state version
   */
  recordKnowledge(
    cardRefId: string,
    cardInstance: CardInstance,
    stateVersion: number,
    isPublic = false,
    workflowId?: string,
    zoneAtReveal?: string
  ): void {
    const existing = this.records.get(cardRefId);
    if (!existing) {
      const record: LocalKnowledgeRecord = {
        card_ref_id: cardRefId,
        card_instance: cardInstance,
        learned_at_state_version: stateVersion,
        learned_at_workflow_id: workflowId,
        is_public: isPublic,
        zone_at_reveal: zoneAtReveal,
      };
      this.records.set(cardRefId, record);
      this.instanceToRef.set(cardInstance.card_instance_id, cardRefId);
    }
  }

  /**
   * Get known plaintext for a CardRef if previously authorized
   */
  getKnownCard(cardRefId: string): CardInstance | null {
    return this.records.get(cardRefId)?.card_instance ?? null;
  }

  /**
   * Check if a CardRef is known by this player
   */
  hasKnowledge(cardRefId: string): boolean {
    return this.records.has(cardRefId);
  }

  /**
   * Get all currently known records
   */
  getAllKnownRecords(): LocalKnowledgeRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Export local knowledge snapshot for client re-hydration
   */
  exportSnapshot(): LocalKnowledgeRecord[] {
    return Array.from(this.records.values());
  }

  /**
   * Import local knowledge snapshot (e.g. after refresh)
   */
  importSnapshot(snapshot: LocalKnowledgeRecord[]): void {
    for (const record of snapshot) {
      this.records.set(record.card_ref_id, record);
      this.instanceToRef.set(record.card_instance.card_instance_id, record.card_ref_id);
    }
  }
}
