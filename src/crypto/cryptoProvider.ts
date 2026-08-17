/**
 * Mental Deck - Cryptographic Provider
 *
 * Security boundary:
 * - Player intent signatures and proof-of-possession use real WebCrypto ECDSA P-256.
 * - Hashing requires WebCrypto SHA-256 and fails closed when unavailable.
 * - Shuffle/re-encryption and joint-encryption primitives remain a TRUSTED-COORDINATOR
 *   PROTOTYPE. Their proof objects are integrity receipts, NOT zero-knowledge proofs.
 *
 * Do not describe this provider as production mental-poker cryptography until the
 * shuffle/encryption layer is replaced by an audited protocol implementation.
 */

import { ProtocolContext, SignedSemanticIntent } from '../types/contracts';

export const CRYPTO_SECURITY_MODEL = Object.freeze({
  mode: 'TRUSTED_COORDINATOR_PROTOTYPE',
  intent_authentication: 'ECDSA_P256',
  proof_of_possession: 'ECDSA_P256',
  joint_encryption: 'SIMULATED',
  verifiable_shuffle: 'SIMULATED_INTEGRITY_RECEIPT',
  partial_decryption: 'SIMULATED_SHARE_WITH_ECDSA_AUTHENTICATION',
} as const);

function requireWebCrypto(): Crypto {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.subtle || !webCrypto.getRandomValues) {
    throw new Error('WebCrypto is required. Refusing to fall back to non-cryptographic primitives.');
  }
  return webCrypto;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map(byte => byte.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-f]*$/i.test(hex) || hex.length % 2 !== 0) {
    throw new Error('Invalid hexadecimal encoding');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

async function importSigningPrivateKey(serializedJwk: string): Promise<CryptoKey> {
  const { subtle } = requireWebCrypto();
  const jwk = JSON.parse(serializedJwk) as JsonWebKey;
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign']
  );
}

async function importSigningPublicKey(serializedJwk: string): Promise<CryptoKey> {
  const { subtle } = requireWebCrypto();
  const jwk = JSON.parse(serializedJwk) as JsonWebKey;
  return subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['verify']
  );
}

async function signDetached(privateKey: string, message: string): Promise<string> {
  const { subtle } = requireWebCrypto();
  const key = await importSigningPrivateKey(privateKey);
  const signature = await subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(message)
  );
  return bytesToHex(new Uint8Array(signature));
}

async function verifyDetached(publicKey: string, signatureHex: string, message: string): Promise<boolean> {
  try {
    const { subtle } = requireWebCrypto();
    const key = await importSigningPublicKey(publicKey);
    return await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      key,
      hexToBytes(signatureHex),
      new TextEncoder().encode(message)
    );
  } catch {
    return false;
  }
}

// Canonical SHA-256 hashing helper. Never silently downgrade to a weak hash.
export async function sha256(data: string | Uint8Array): Promise<string> {
  const { subtle } = requireWebCrypto();
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await subtle.digest('SHA-256', bytes);
  return bytesToHex(new Uint8Array(hashBuffer));
}

export function canonicalJson(obj: unknown): string {
  if (obj === undefined) return 'null';
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(canonicalJson).join(',')}]`;
  }
  const keys = Object.keys(obj as Record<string, unknown>)
    .filter(key => (obj as Record<string, unknown>)[key] !== undefined)
    .sort();
  const pairs = keys.map(
    key => `"${key}":${canonicalJson((obj as Record<string, unknown>)[key])}`
  );
  return `{${pairs.join(',')}}`;
}

export async function hashCanonical(obj: unknown): Promise<string> {
  return sha256(canonicalJson(obj));
}

export async function computeContextHash(ctx: ProtocolContext): Promise<string> {
  return hashCanonical({
    domain: 'MENTAL_DECK_PROTOCOL_V09',
    protocol_id: ctx.protocol_id,
    protocol_version: ctx.protocol_version,
    game_id: ctx.game_id,
    roster_hash: ctx.roster_hash,
    definition_hash: ctx.definition_hash,
    phase: ctx.phase,
    actor_id: ctx.actor_id || '',
    workflow_id: ctx.workflow_id || '',
    action_id: ctx.action_id || '',
    base_state_hash: ctx.base_state_hash || '',
    input_hash: ctx.input_hash || '',
  });
}

export interface KeyPair {
  privateKey: string;
  publicKey: string;
  pokProof: string;
}

export class MentalDeckCrypto {
  /**
   * Generate an exportable ECDSA P-256 keypair for the local prototype.
   *
   * The same underlying P-256 pair is currently exposed as both the signing and
   * prototype "encryption" key so the existing single-key demo plumbing remains
   * compatible. This is NOT production key separation and is documented as such.
   */
  static async generatePlayerKeys(playerId: string, _gameId: string): Promise<{
    signing: KeyPair;
    encryption: KeyPair;
  }> {
    const { subtle } = requireWebCrypto();
    const pair = (await subtle.generateKey(
      { name: 'ECDSA', namedCurve: 'P-256' },
      true,
      ['sign', 'verify']
    )) as CryptoKeyPair;

    const privateJwk = await subtle.exportKey('jwk', pair.privateKey);
    const publicJwk = await subtle.exportKey('jwk', pair.publicKey);
    const privateKey = JSON.stringify(privateJwk);
    const publicKey = JSON.stringify(publicJwk);
    const pokProof = await signDetached(
      privateKey,
      `MENTAL_DECK_POK_V1:${playerId}:${publicKey}`
    );

    const keyPair: KeyPair = { privateKey, publicKey, pokProof };
    return {
      signing: keyPair,
      encryption: { ...keyPair },
    };
  }

  /** Verify proof-of-possession for the registered public key. */
  static async verifyPoK(playerId: string, publicKey: string, pokProof: string): Promise<boolean> {
    return verifyDetached(
      publicKey,
      pokProof,
      `MENTAL_DECK_POK_V1:${playerId}:${publicKey}`
    );
  }

  /**
   * Prototype joint-key identifier. This is a deterministic commitment to the
   * roster public keys, not an actual threshold-encryption public key.
   */
  static async deriveJointPublicKey(playerPublicKeys: string[]): Promise<string> {
    const sorted = [...playerPublicKeys].sort();
    return sha256(`DEMO_JOINT_KEY_COMMITMENT:${sorted.join(':')}`);
  }

  /** Sign an arbitrary canonical payload with an explicit protocol context. */
  static async signPayload(
    privateKey: string,
    payload: unknown,
    context: ProtocolContext
  ): Promise<string> {
    const payloadHash = await hashCanonical(payload);
    const ctxHash = await computeContextHash(context);
    return signDetached(privateKey, `MENTAL_DECK_PAYLOAD_V1:${ctxHash}:${payloadHash}`);
  }

  /** Verify a contextual ECDSA payload signature. */
  static async verifySignature(
    publicKey: string,
    signature: string,
    payload: unknown,
    context: ProtocolContext
  ): Promise<boolean> {
    const payloadHash = await hashCanonical(payload);
    const ctxHash = await computeContextHash(context);
    return verifyDetached(
      publicKey,
      signature,
      `MENTAL_DECK_PAYLOAD_V1:${ctxHash}:${payloadHash}`
    );
  }

  /**
   * Sign every semantic field of an intent. Parameters, actor, plugin, base
   * state/version, intent id and timestamp are all bound by the signature.
   */
  static async signIntent(
    privateKey: string,
    unsignedIntent: Omit<SignedSemanticIntent, 'signature'>
  ): Promise<string> {
    const payloadHash = await hashCanonical(unsignedIntent);
    return signDetached(privateKey, `MENTAL_DECK_INTENT_V1:${payloadHash}`);
  }

  static async verifyIntentSignature(
    publicKey: string,
    intent: SignedSemanticIntent
  ): Promise<boolean> {
    const { signature, ...unsignedIntent } = intent;
    const payloadHash = await hashCanonical(unsignedIntent);
    return verifyDetached(publicKey, signature, `MENTAL_DECK_INTENT_V1:${payloadHash}`);
  }

  /**
   * PROTOTYPE ONLY: deterministic keyed permutation and opaque ref rotation.
   * The returned proof is an integrity receipt; it does not prove a zero-knowledge
   * permutation/re-encryption relation.
   */
  static async shuffleAndProve(
    inputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    playerEncryptionKey: string,
    context: ProtocolContext,
    newEpoch: number
  ): Promise<{
    outputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>;
    refMapping?: Array<{ from: string; to: string }>;
    proof: {
      inputCommitment: string;
      outputCommitment: string;
      permutationProof: string;
      contextHash: string;
    };
  }> {
    const N = inputCiphers.length;
    if (N < 1 || N >= 200) {
      throw new Error(`Invalid card count N=${N}. Must be 1 <= N < 200.`);
    }
    if (!playerEncryptionKey) {
      throw new Error('Missing player shuffle secret; refusing insecure default-key fallback.');
    }

    const ctxHash = await computeContextHash(context);
    const inputCommitment = await hashCanonical(inputCiphers);
    const shuffled = [...inputCiphers];
    const permSeed = await sha256(
      `DEMO_SHUFFLE_SEED:${playerEncryptionKey}:${ctxHash}:${newEpoch}`
    );

    for (let i = shuffled.length - 1; i > 0; i--) {
      const stepHash = await sha256(`${permSeed}:${i}`);
      const j = Number.parseInt(stepHash.substring(0, 8), 16) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const refMapping: Array<{ from: string; to: string }> = [];
    const outputCiphers = await Promise.all(
      shuffled.map(async (item, idx) => {
        const refDigest = await sha256(
          `${item.card_ref.ref_id}:${playerEncryptionKey}:${idx}:${ctxHash}`
        );
        const newRefId = `ref_ep${newEpoch}_${refDigest.substring(0, 12)}`;
        const reEncryptedCipher = await sha256(
          `DEMO_REENC:${item.ciphertext}:${playerEncryptionKey}:${newEpoch}:${ctxHash}`
        );
        refMapping.push({ from: item.card_ref.ref_id, to: newRefId });
        return {
          card_ref: { ref_id: newRefId, epoch: newEpoch },
          ciphertext: reEncryptedCipher,
        };
      })
    );

    const outputCommitment = await hashCanonical(outputCiphers);
    const permutationProof = await sha256(
      `DEMO_SHUFFLE_RECEIPT:${inputCommitment}:${outputCommitment}:${ctxHash}`
    );

    return {
      outputCiphers,
      refMapping,
      proof: {
        inputCommitment,
        outputCommitment,
        permutationProof,
        contextHash: ctxHash,
      },
    };
  }

  /** Verify only the prototype shuffle receipt's internal integrity. */
  static async verifyShuffleProof(
    inputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    outputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    proof: {
      inputCommitment: string;
      outputCommitment: string;
      permutationProof: string;
      contextHash: string;
    },
    context: ProtocolContext
  ): Promise<boolean> {
    if (inputCiphers.length !== outputCiphers.length) return false;
    const N = inputCiphers.length;
    if (N < 1 || N >= 200) return false;

    const expectedCtxHash = await computeContextHash(context);
    if (proof.contextHash !== expectedCtxHash) return false;

    const computedInputCommitment = await hashCanonical(inputCiphers);
    if (proof.inputCommitment !== computedInputCommitment) return false;

    const computedOutputCommitment = await hashCanonical(outputCiphers);
    if (proof.outputCommitment !== computedOutputCommitment) return false;

    const expectedProof = await sha256(
      `DEMO_SHUFFLE_RECEIPT:${computedInputCommitment}:${computedOutputCommitment}:${expectedCtxHash}`
    );
    return proof.permutationProof === expectedProof;
  }

  /**
   * PROTOTYPE ONLY: derive an opaque share and authenticate it with ECDSA.
   * This is not a threshold-decryption or DLEQ implementation.
   */
  static async generateDecryptShare(
    cardRefId: string,
    playerEncryptionPrivKey: string,
    workflowId: string,
    stageId: string,
    context: ProtocolContext
  ): Promise<{ share: string; proof: string }> {
    const ctxHash = await computeContextHash(context);
    const share = await sha256(
      `DEMO_DECRYPT_SHARE:${cardRefId}:${playerEncryptionPrivKey}:${workflowId}:${stageId}:${ctxHash}`
    );
    const proof = await signDetached(
      playerEncryptionPrivKey,
      `MENTAL_DECK_SHARE_AUTH_V1:${cardRefId}:${share}:${ctxHash}`
    );
    return { share, proof };
  }

  /** Authenticate a prototype partial-decryption share with the player's public key. */
  static async verifyDecryptShare(
    cardRefId: string,
    share: string,
    proof: string,
    playerPublicKey: string,
    context: ProtocolContext
  ): Promise<boolean> {
    const ctxHash = await computeContextHash(context);
    return verifyDetached(
      playerPublicKey,
      proof,
      `MENTAL_DECK_SHARE_AUTH_V1:${cardRefId}:${share}:${ctxHash}`
    );
  }
}
