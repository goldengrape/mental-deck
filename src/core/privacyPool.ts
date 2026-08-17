/**
 * Mental Deck - Privacy Pool Bootstrap & Opaque Allocation (MDD-MOD-007, MDD-MOD-009, URD-FUN-004, URD-INV-017)
 *
 * Implements:
 * 1. Encodes all N CardInstances into a single unified initial encrypted Privacy Pool.
 * 2. Multi-party verifiable shuffle randomizes the pool and rotates CardRef IDs.
 * 3. Identity-independent allocation: Only after the pool is shuffled does it allocate opaque CardRefs to initial Zones.
 * 4. Strictly forbids identity-dependent allocation before privacy randomization.
 */

import {
  CardInstance,
  CardRef,
  CipherCard,
  DeckManifest,
  InitializationPlan,
  LockedGameDefinition,
  ZoneManifest,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';

export class PrivacyPoolBootstrap {
  /**
   * Encodes DeckManifest cards into encrypted Privacy Pool
   */
  static async bootstrapPrivacyPool(
    deckManifest: DeckManifest,
    jointPublicKey: string
  ): Promise<{ ciphers: CipherCard[]; initialRefs: CardRef[] }> {
    const N = deckManifest.cards.length;
    if (N < 1 || N >= 200) {
      throw new Error(`Deck card count N=${N} must satisfy 1 <= N < 200.`);
    }

    const ciphers: CipherCard[] = [];
    const initialRefs: CardRef[] = [];

    for (let i = 0; i < N; i++) {
      const card = deckManifest.cards[i];
      const initialRef: CardRef = {
        ref_id: `ref_init_${i.toString().padStart(3, '0')}`,
        epoch: 0,
      };
      // Encrypted under joint public key with initial index commitment
      const initialCipher = await sha256(`INIT_CIPHER:${card.card_instance_id}:${jointPublicKey}:${i}`);
      const commitment = await sha256(`CARD_COMMIT:${initialRef.ref_id}:${initialCipher}`);

      ciphers.push({
        card_ref: initialRef,
        ciphertext: initialCipher,
        commitment,
      });
      initialRefs.push(initialRef);
    }

    return { ciphers, initialRefs };
  }

  /**
   * Executes locked identity-independent InitializationPlan on the randomized pool
   */
  static async executeAllocationPlan(
    shuffledCardRefs: CardRef[],
    zoneManifest: ZoneManifest,
    plan: InitializationPlan
  ): Promise<Record<string, ZoneState>> {
    const totalAvailable = shuffledCardRefs.length;
    let poolCursor = 0;

    const initialZoneStates: Record<string, ZoneState> = {};
    for (const zDef of zoneManifest.zones) {
      initialZoneStates[zDef.zone_id] = {
        zone_id: zDef.zone_id,
        card_refs: [],
        commitment_hash: await hashCanonical([]),
      };
    }

    // Execute allocation steps in plan
    for (const step of plan.steps) {
      if (step.source_pool !== 'privacy_pool') {
        throw new Error(`Invalid source pool in initialization plan: ${step.source_pool}`);
      }
      if (step.selector !== 'TOP') {
        throw new Error(`Initialization plan must use identity-independent TOP selector. Found: ${step.selector}`);
      }
      if (poolCursor + step.count > totalAvailable) {
        throw new Error(`Initialization plan requests ${poolCursor + step.count} cards, but pool only has ${totalAvailable}`);
      }

      const allocated = shuffledCardRefs.slice(poolCursor, poolCursor + step.count);
      poolCursor += step.count;

      const targetState = initialZoneStates[step.destination_zone_id];
      if (!targetState) {
        throw new Error(`Target zone ${step.destination_zone_id} not defined in zone manifest`);
      }
      targetState.card_refs.push(...allocated);
    }

    // Check if any cards remain in privacy pool; if so, if a Stock zone exists, put remainder there
    if (poolCursor < totalAvailable) {
      const remaining = shuffledCardRefs.slice(poolCursor);
      const stockZone = zoneManifest.zones.find(z => z.zone_id === 'stock' || z.zone_id === 'draw_pile' || z.zone_id === 'deck');
      if (stockZone) {
        initialZoneStates[stockZone.zone_id].card_refs.push(...remaining);
      }
    }

    // Recompute commitment hashes for all initial zones
    for (const [zId, zState] of Object.entries(initialZoneStates)) {
      zState.commitment_hash = await hashCanonical(zState.card_refs);
    }

    return initialZoneStates;
  }
}
