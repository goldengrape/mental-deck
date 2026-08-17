/**
 * Mental Deck - Simulation Crypto Provider.
 *
 * IMPORTANT: this file is intentionally NOT a production Mental Poker provider.
 * It exists to exercise protocol/state-machine wiring while RMD-TASK-004 selects
 * a real browser/WASM provider for ElGamal, verifiable shuffle and DLEQ.
 *
 * Security-sensitive code must not advertise this provider as zero-knowledge or
 * production-secure. Functions fail closed when WebCrypto entropy/hash support is
 * unavailable. Signature/PoK verification is meaningful only inside this single
 * simulation runtime through an in-memory key registry.
 */

import { ProtocolContext } from '../types/contracts';

export const CRYPTO_SECURITY_STATUS = 'SIMULATION_ONLY' as const;
export const PRODUCTION_CRYPTO_AVAILABLE = false;

const signingSecretByPublicKey = new Map<string, string>();
const encryptionSecretByPublicKey = new Map<string, string>();

function requireWebCrypto(): Crypto {
  if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
    throw new Error('WebCrypto unavailable; simulation crypto fails closed');
  }
  return crypto;
}

export async function sha256(data: string | Uint8Array): Promise<string> {
  const c = requireWebCrypto();
  const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
  const hashBuffer = await c.subtle.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export function canonicalJson(obj: unknown): string {
  if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
  if (Array.isArray(obj)) return `[${obj.map(canonicalJson).join(',')}]`;
  const keys = Object.keys(obj as Record<string, unknown>).sort();
  return `{${keys.map(k => `"${k}":${canonicalJson((obj as Record<string, unknown>)[k])}`).join(',')}}`;
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

function randomHex(bytes: number): string {
  const c = requireWebCrypto();
  const data = c.getRandomValues(new Uint8Array(bytes));
  return Array.from(data).map(b => b.toString(16).padStart(2, '0')).join('');
}

export class MentalDeckCrypto {
  static readonly securityStatus = CRYPTO_SECURITY_STATUS;

  static assertProductionReady(): never {
    throw new Error(
      'Production Mental Poker crypto provider is not installed. Current provider is SIMULATION_ONLY (RMD-TASK-004 remains a hard gate).'
    );
  }

  static async generatePlayerKeys(playerId: string, gameId: string): Promise<{
    signing: KeyPair;
    encryption: KeyPair;
  }> {
    const encPriv = randomHex(32);
    const encPub = await sha256(`SIM_ENC_PUB:${playerId}:${gameId}:${encPriv}`);
    encryptionSecretByPublicKey.set(encPub, encPriv);

    const pokNonce = randomHex(32);
    const challenge = await sha256(`SIM_POK_CHALLENGE:${playerId}:${gameId}:${encPub}:${pokNonce}`);
    const response = await sha256(`SIM_POK_RESPONSE:${encPriv}:${challenge}`);
    const pokProof = JSON.stringify({ gameId, nonce: pokNonce, challenge, response });

    const signPriv = randomHex(32);
    const signPub = await sha256(`SIM_SIGN_PUB:${playerId}:${gameId}:${signPriv}`);
    signingSecretByPublicKey.set(signPub, signPriv);
    const signPok = await sha256(`SIM_SIGN_POK:${signPriv}:${signPub}`);

    return {
      signing: { privateKey: signPriv, publicKey: signPub, pokProof: signPok },
      encryption: { privateKey: encPriv, publicKey: encPub, pokProof },
    };
  }

  static async verifyPoK(playerId: string, publicKey: string, pokProofStr: string): Promise<boolean> {
    try {
      const proof = JSON.parse(pokProofStr) as { gameId?: string; nonce?: string; challenge?: string; response?: string };
      if (!proof.gameId || !proof.nonce || !proof.challenge || !proof.response) return false;
      const privateKey = encryptionSecretByPublicKey.get(publicKey);
      if (!privateKey) return false; // separate-runtime verification requires the future real provider
      const expectedPublic = await sha256(`SIM_ENC_PUB:${playerId}:${proof.gameId}:${privateKey}`);
      if (expectedPublic !== publicKey) return false;
      const expectedChallenge = await sha256(`SIM_POK_CHALLENGE:${playerId}:${proof.gameId}:${publicKey}:${proof.nonce}`);
      if (expectedChallenge !== proof.challenge) return false;
      const expectedResponse = await sha256(`SIM_POK_RESPONSE:${privateKey}:${proof.challenge}`);
      return expectedResponse === proof.response;
    } catch {
      return false;
    }
  }

  static async deriveJointPublicKey(playerPublicKeys: string[]): Promise<string> {
    if (playerPublicKeys.length < 2 || new Set(playerPublicKeys).size !== playerPublicKeys.length) {
      throw new Error('Joint key setup requires at least two distinct participant public keys');
    }
    return sha256(`SIM_JOINT_PUB_KEY:${[...playerPublicKeys].sort().join(':')}`);
  }

  static async signPayload(privateKey: string, payload: unknown, context: ProtocolContext): Promise<string> {
    const payloadHash = await hashCanonical(payload);
    const ctxHash = await computeContextHash(context);
    return sha256(`SIM_SIG:${privateKey}:${ctxHash}:${payloadHash}`);
  }

  static async verifySignature(
    publicKey: string,
    signature: string,
    payload: unknown,
    context: ProtocolContext
  ): Promise<boolean> {
    const privateKey = signingSecretByPublicKey.get(publicKey);
    if (!privateKey || !signature) return false;
    return signature === await this.signPayload(privateKey, payload, context);
  }

  static async signSemanticIntent(privateKey: string, unsignedIntent: unknown): Promise<string> {
    return sha256(`SIM_INTENT_SIG:${privateKey}:${await hashCanonical(unsignedIntent)}`);
  }

  static async verifySemanticIntent(publicKey: string, signature: string, unsignedIntent: unknown): Promise<boolean> {
    const privateKey = signingSecretByPublicKey.get(publicKey);
    if (!privateKey || !signature) return false;
    return signature === await this.signSemanticIntent(privateKey, unsignedIntent);
  }

  static async shuffleAndProve(
    inputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    playerEncryptionKey: string,
    context: ProtocolContext,
    newEpoch: number
  ): Promise<{
    outputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>;
    refMapping?: Array<{ from: string; to: string }>;
    proof: { inputCommitment: string; outputCommitment: string; permutationProof: string; contextHash: string };
  }> {
    const N = inputCiphers.length;
    if (N < 1 || N >= 200) throw new Error(`Invalid card count N=${N}. Must be 1 <= N < 200.`);

    const ctxHash = await computeContextHash(context);
    const inputCommitment = await hashCanonical(inputCiphers);
    const shuffled = [...inputCiphers];
    const permSeed = await sha256(`SIM_SHUFFLE_SEED:${playerEncryptionKey}:${ctxHash}:${newEpoch}`);
    for (let i = shuffled.length - 1; i > 0; i--) {
      const stepHash = await sha256(`${permSeed}:${i}`);
      const j = Number.parseInt(stepHash.substring(0, 8), 16) % (i + 1);
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }

    const refMapping: Array<{ from: string; to: string }> = [];
    const outputCiphers = await Promise.all(shuffled.map(async (item, idx) => {
      const newRefId = `ref_ep${newEpoch}_${(await sha256(`${item.card_ref.ref_id}:${playerEncryptionKey}:${idx}`)).substring(0, 12)}`;
      refMapping.push({ from: item.card_ref.ref_id, to: newRefId });
      return {
        card_ref: { ref_id: newRefId, epoch: newEpoch },
        ciphertext: await sha256(`SIM_REENC:${item.ciphertext}:${playerEncryptionKey}:${newEpoch}`),
      };
    }));

    const outputCommitment = await hashCanonical(outputCiphers);
    // Simulation transcript integrity marker only; NOT a zero-knowledge shuffle proof.
    const permutationProof = await sha256(`SIM_SHUFFLE_TRANSCRIPT:${inputCommitment}:${outputCommitment}:${ctxHash}`);
    return { outputCiphers, refMapping, proof: { inputCommitment, outputCommitment, permutationProof, contextHash: ctxHash } };
  }

  static async verifyShuffleProof(
    inputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    outputCiphers: Array<{ card_ref: { ref_id: string; epoch: number }; ciphertext: string }>,
    proof: { inputCommitment: string; outputCommitment: string; permutationProof: string; contextHash: string },
    context: ProtocolContext
  ): Promise<boolean> {
    if (inputCiphers.length !== outputCiphers.length || inputCiphers.length < 1 || inputCiphers.length >= 200) return false;
    const expectedCtxHash = await computeContextHash(context);
    if (proof.contextHash !== expectedCtxHash) return false;
    const inputCommitment = await hashCanonical(inputCiphers);
    const outputCommitment = await hashCanonical(outputCiphers);
    if (proof.inputCommitment !== inputCommitment || proof.outputCommitment !== outputCommitment) return false;
    return proof.permutationProof === await sha256(`SIM_SHUFFLE_TRANSCRIPT:${inputCommitment}:${outputCommitment}:${expectedCtxHash}`);
  }

  static async generateDecryptShare(
    cardRefId: string,
    playerEncryptionPrivKey: string,
    workflowId: string,
    stageId: string,
    context: ProtocolContext
  ): Promise<{ share: string; proof: string }> {
    const ctxHash = await computeContextHash(context);
    const share = await sha256(`SIM_DECRYPT_SHARE:${cardRefId}:${playerEncryptionPrivKey}:${workflowId}:${stageId}`);
    const proof = await sha256(`SIM_DLEQ_TRANSCRIPT:${cardRefId}:${share}:${ctxHash}`);
    return { share, proof };
  }

  static async verifyDecryptShare(
    cardRefId: string,
    share: string,
    proof: string,
    _playerPublicKey: string,
    context: ProtocolContext
  ): Promise<boolean> {
    // Transcript integrity check only. A real DLEQ verifier is required before production.
    const ctxHash = await computeContextHash(context);
    return proof === await sha256(`SIM_DLEQ_TRANSCRIPT:${cardRefId}:${share}:${ctxHash}`);
  }
}
