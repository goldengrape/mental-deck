/**
 * Mental Deck - Local Per-Game Secret Vault.
 *
 * Browser-only encrypted persistence for ephemeral per-game key material.
 * Uses PBKDF2-SHA-256 + AES-GCM. No XOR/custom stream cipher fallback is allowed.
 */

import { LocalKeyMaterial } from '../types/contracts';
import { MentalDeckCrypto } from './cryptoProvider';

type VaultEnvelopeV2 = {
  version: 2;
  gameId: string;
  playerId: string;
  kdf: 'PBKDF2-SHA-256';
  iterations: number;
  salt: string;
  iv: string;
  ciphertext: string;
};

const PBKDF2_ITERATIONS = 210_000;

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  if (!/^[0-9a-fA-F]*$/.test(hex) || hex.length % 2 !== 0) throw new Error('Invalid hex encoding');
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export class LocalSecretVault {
  private static storageKey(gameId: string, playerId: string): string {
    return `mental_deck_vault_v2_${gameId}_${playerId}`;
  }

  static async getOrCreateKeys(
    gameId: string,
    playerId: string,
    passphrase: string
  ): Promise<{ keyMaterial: LocalKeyMaterial; isNew: boolean }> {
    if (!passphrase) throw new Error('Vault passphrase must not be empty');
    const key = this.storageKey(gameId, playerId);
    const existingCiphertext = typeof window !== 'undefined' ? window.sessionStorage.getItem(key) : null;

    if (existingCiphertext) {
      try {
        return {
          keyMaterial: await this.decryptVault(existingCiphertext, passphrase, gameId, playerId),
          isNew: false,
        };
      } catch {
        throw new Error(`Failed to unlock vault for game ${gameId}: incorrect passphrase or corrupted vault`);
      }
    }

    const keys = await MentalDeckCrypto.generatePlayerKeys(playerId, gameId);
    const keyMaterial: LocalKeyMaterial = {
      game_id: gameId,
      player_id: playerId,
      signing_private_key: keys.signing.privateKey,
      signing_public_key: keys.signing.publicKey,
      encryption_private_key: keys.encryption.privateKey,
      encryption_public_key: keys.encryption.publicKey,
      pok_proof: keys.encryption.pokProof,
      created_at: Date.now(),
    };

    const encrypted = await this.encryptVault(keyMaterial, passphrase, gameId, playerId);
    if (typeof window !== 'undefined') window.sessionStorage.setItem(key, encrypted);
    return { keyMaterial, isNew: true };
  }

  static clearVault(gameId: string, playerId: string): void {
    if (typeof window !== 'undefined') window.sessionStorage.removeItem(this.storageKey(gameId, playerId));
  }

  private static requireWebCrypto(): SubtleCrypto {
    if (typeof crypto === 'undefined' || !crypto.subtle || !crypto.getRandomValues) {
      throw new Error('WebCrypto unavailable; secret vault fails closed');
    }
    return crypto.subtle;
  }

  private static async deriveAesKey(passphrase: string, salt: Uint8Array, iterations: number): Promise<CryptoKey> {
    const subtle = this.requireWebCrypto();
    const passphraseKey = await subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
      passphraseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  private static additionalData(gameId: string, playerId: string): Uint8Array {
    return new TextEncoder().encode(`MENTAL_DECK_VAULT_V2:${gameId}:${playerId}`);
  }

  private static async encryptVault(
    keyMaterial: LocalKeyMaterial,
    passphrase: string,
    gameId: string,
    playerId: string
  ): Promise<string> {
    const subtle = this.requireWebCrypto();
    const salt = crypto.getRandomValues(new Uint8Array(16));
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const key = await this.deriveAesKey(passphrase, salt, PBKDF2_ITERATIONS);
    const plaintext = new TextEncoder().encode(JSON.stringify(keyMaterial));
    const ciphertext = new Uint8Array(
      await subtle.encrypt(
        { name: 'AES-GCM', iv, additionalData: this.additionalData(gameId, playerId), tagLength: 128 },
        key,
        plaintext
      )
    );

    const envelope: VaultEnvelopeV2 = {
      version: 2,
      gameId,
      playerId,
      kdf: 'PBKDF2-SHA-256',
      iterations: PBKDF2_ITERATIONS,
      salt: bytesToHex(salt),
      iv: bytesToHex(iv),
      ciphertext: bytesToHex(ciphertext),
    };
    return JSON.stringify(envelope);
  }

  private static async decryptVault(
    envelopeStr: string,
    passphrase: string,
    gameId: string,
    playerId: string
  ): Promise<LocalKeyMaterial> {
    const subtle = this.requireWebCrypto();
    const envelope = JSON.parse(envelopeStr) as VaultEnvelopeV2;
    if (envelope.version !== 2 || envelope.kdf !== 'PBKDF2-SHA-256') throw new Error('Unsupported vault format');
    if (envelope.gameId !== gameId || envelope.playerId !== playerId) throw new Error('Vault game/player mismatch');
    if (!Number.isInteger(envelope.iterations) || envelope.iterations < 100_000) throw new Error('Unsafe vault KDF parameters');

    const salt = hexToBytes(envelope.salt);
    const iv = hexToBytes(envelope.iv);
    const ciphertext = hexToBytes(envelope.ciphertext);
    const key = await this.deriveAesKey(passphrase, salt, envelope.iterations);
    const plaintext = await subtle.decrypt(
      { name: 'AES-GCM', iv, additionalData: this.additionalData(gameId, playerId), tagLength: 128 },
      key,
      ciphertext
    );
    const decoded = JSON.parse(new TextDecoder().decode(plaintext)) as LocalKeyMaterial;
    if (decoded.game_id !== gameId || decoded.player_id !== playerId) throw new Error('Decrypted vault identity mismatch');
    return decoded;
  }
}
