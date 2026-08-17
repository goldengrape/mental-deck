/**
 * Mental Deck - Prototype Privacy Pool Bootstrap & Opaque Allocation
 *
 * This module creates randomized opaque card blobs and allocates only CardRefs.
 * It is deliberately NOT described as threshold/joint encryption: production
 * mental poker must replace this with a real audited cryptographic construction.
 */

import {
  CardRef,
  CipherCard,
  DeckManifest,
  InitializationPlan,
  ZoneManifest,
  ZoneState,
} from '../types/contracts';
import { hashCanonical, sha256 } from '../crypto/cryptoProvider';

function randomHex(bytes: number): string {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.getRandomValues) {
    throw new Error('CSPRNG is required for privacy-pool bootstrap.');
  }
  const buffer = new Uint8Array(bytes);
  webCrypto.getRandomValues(buffer);
  return Array.from(buffer)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

export class PrivacyPoolBootstrap {
  static async bootstrapPrivacyPool(
    deckManifest: DeckManifest,
    jointPublicKeyCommitment: string
  ): Promise<{ ciphers: CipherCard[]; initialRefs: CardRef[] }> {
    const cardCount = deckManifest.cards.length;
    if (cardCount < 1 || cardCount >= 200) {
      throw new Error(
        `Deck card count N=${cardCount} must satisfy 1 <= N < 200.`
      );
    }

    const ciphers: CipherCard[] = [];
    const initialRefs: CardRef[] = [];

    for (let index = 0; index < cardCount; index++) {
      const card = deckManifest.cards[index];
      const initialRef: CardRef = {
        ref_id: `ref_init_${index.toString().padStart(3, '0')}`,
        epoch: 0,
      };

      // Randomized opaque prototype blob. The nonce is intentionally not exposed;
      // this prevents public deterministic dictionary matching of CardInstance ids.
      const nonce = randomHex(32);
      const opaqueCipher = await sha256(
        `DEMO_OPAQUE_CARD_V1:${card.card_instance_id}:${jointPublicKeyCommitment}:${index}:${nonce}`
      );
      const commitment = await sha256(
        `CARD_COMMIT_V1:${initialRef.ref_id}:${opaqueCipher}`
      );

      ciphers.push({
        card_ref: initialRef,
        ciphertext: opaqueCipher,
        commitment,
      });
      initialRefs.push(initialRef);
    }

    return { ciphers, initialRefs };
  }

  static async executeAllocationPlan(
    shuffledCardRefs: CardRef[],
    zoneManifest: ZoneManifest,
    plan: InitializationPlan
  ): Promise<Record<string, ZoneState>> {
    const totalAvailable = shuffledCardRefs.length;
    let poolCursor = 0;

    const initialZoneStates: Record<string, ZoneState> = {};
    for (const zoneDefinition of zoneManifest.zones) {
      initialZoneStates[zoneDefinition.zone_id] = {
        zone_id: zoneDefinition.zone_id,
        card_refs: [],
        commitment_hash: await hashCanonical([]),
      };
    }

    for (const step of plan.steps) {
      if (step.source_pool !== 'privacy_pool') {
        throw new Error(
          `Invalid source pool in initialization plan: ${step.source_pool}`
        );
      }
      if (step.selector !== 'TOP') {
        throw new Error(
          `Initialization plan must use identity-independent TOP selector. Found: ${step.selector}`
        );
      }
      if (!Number.isInteger(step.count) || step.count < 0) {
        throw new Error(`Invalid allocation count in step ${step.step_id}`);
      }
      if (poolCursor + step.count > totalAvailable) {
        throw new Error(
          `Initialization plan requests ${poolCursor + step.count} cards, but pool only has ${totalAvailable}`
        );
      }

      const allocated = shuffledCardRefs.slice(
        poolCursor,
        poolCursor + step.count
      );
      poolCursor += step.count;

      const targetState = initialZoneStates[step.destination_zone_id];
      if (!targetState) {
        throw new Error(
          `Target zone ${step.destination_zone_id} not defined in zone manifest`
        );
      }
      targetState.card_refs.push(...allocated);
    }

    if (poolCursor < totalAvailable) {
      const remaining = shuffledCardRefs.slice(poolCursor);
      const stockZone = zoneManifest.zones.find(
        zone =>
          zone.zone_id === 'stock' ||
          zone.zone_id === 'draw_pile' ||
          zone.zone_id === 'deck'
      );
      if (!stockZone) {
        throw new Error(
          `Initialization plan left ${remaining.length} cards unallocated and no stock zone exists.`
        );
      }
      initialZoneStates[stockZone.zone_id].card_refs.push(...remaining);
    }

    for (const zoneState of Object.values(initialZoneStates)) {
      zoneState.commitment_hash = await hashCanonical(zoneState.card_refs);
    }
    return initialZoneStates;
  }
}
