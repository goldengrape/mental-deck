/**
 * Mental Deck - Local Per-Game Secret Vault
 *
 * Uses PBKDF2-SHA256 + AES-GCM with a random salt and IV. The passphrase only
 * protects the local vault; it is never used directly as a game/protocol key.
 */

import { LocalKeyMaterial } from '../types/contracts';
import { MentalDeckCrypto } from './cryptoProvider';

interface VaultEnvelopeV2 {
  version: 2;
  gameId: string;
  playerId: string;
  saltHex: string;
  ivHex: string;
  ciphertextHex: string;
  kdf: 'PBKDF2-SHA256';
  iterations: number;
  cipher: 'AES-GCM-256';
}

const PBKDF2_ITERATIONS = 210_000;

function requireWebCrypto(): Crypto {
  const webCrypto = globalThis.crypto;
  if (!webCrypto?.subtle || !webCrypto.getRandomValues) {
    throw new Error('WebCrypto is required for the local secret vault.');
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
    throw new Error('Invalid vault hex encoding.');
  }
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
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
    if (!passphrase) {
      throw new Error('A non-empty passphrase is required to protect the local vault.');
    }

    const storageKey = this.storageKey(gameId, playerId);
    const existing =
      typeof window !== 'undefined'
        ? window.sessionStorage.getItem(storageKey)
        : null;

    if (existing) {
      try {
        const decrypted = await this.decryptVault(
          existing,
          passphrase,
          gameId,
          playerId
        );
        return { keyMaterial: decrypted, isNew: false };
      } catch {
        throw new Error(
          `Failed to unlock vault for game ${gameId}: incorrect passphrase, corrupted vault, or unsupported legacy format.`
        );
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

    const encrypted = await this.encryptVault(
      keyMaterial,
      passphrase,
      gameId,
      playerId
    );
    if (typeof window !== 'undefined') {
      window.sessionStorage.setItem(storageKey, encrypted);
    }
    return { keyMaterial, isNew: true };
  }

  static clearVault(gameId: string, playerId: string): void {
    if (typeof window !== 'undefined') {
      window.sessionStorage.removeItem(this.storageKey(gameId, playerId));
    }
  }

  private static async deriveVaultKey(
    passphrase: string,
    salt: Uint8Array,
    iterations: number
  ): Promise<CryptoKey> {
    const { subtle } = requireWebCrypto();
    const baseKey = await subtle.importKey(
      'raw',
      new TextEncoder().encode(passphrase),
      'PBKDF2',
      false,
      ['deriveKey']
    );
    return subtle.deriveKey(
      {
        name: 'PBKDF2',
        hash: 'SHA-256',
        salt,
        iterations,
      },
      baseKey,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt']
    );
  }

  private static associatedData(gameId: string, playerId: string): Uint8Array {
    return new TextEncoder().encode(
      `MENTAL_DECK_VAULT_V2:${gameId}:${playerId}`
    );
  }

  private static async encryptVault(
    keyMaterial: LocalKeyMaterial,
    passphrase: string,
    gameId: string,
    playerId: string
  ): Promise<string> {
    const webCrypto = requireWebCrypto();
    const salt = new Uint8Array(16);
    const iv = new Uint8Array(12);
    webCrypto.getRandomValues(salt);
    webCrypto.getRandomValues(iv);

    const key = await this.deriveVaultKey(
      passphrase,
      salt,
      PBKDF2_ITERATIONS
    );
    const plaintext = new TextEncoder().encode(JSON.stringify(keyMaterial));
    const ciphertext = await webCrypto.subtle.encrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: this.associatedData(gameId, playerId),
        tagLength: 128,
      },
      key,
      plaintext
    );

    const envelope: VaultEnvelopeV2 = {
      version: 2,
      gameId,
      playerId,
      saltHex: bytesToHex(salt),
      ivHex: bytesToHex(iv),
      ciphertextHex: bytesToHex(new Uint8Array(ciphertext)),
      kdf: 'PBKDF2-SHA256',
      iterations: PBKDF2_ITERATIONS,
      cipher: 'AES-GCM-256',
    };
    return JSON.stringify(envelope);
  }

  private static async decryptVault(
    envelopeString: string,
    passphrase: string,
    gameId: string,
    playerId: string
  ): Promise<LocalKeyMaterial> {
    const envelope = JSON.parse(envelopeString) as Partial<VaultEnvelopeV2>;
    if (
      envelope.version !== 2 ||
      envelope.gameId !== gameId ||
      envelope.playerId !== playerId ||
      envelope.kdf !== 'PBKDF2-SHA256' ||
      envelope.cipher !== 'AES-GCM-256' ||
      typeof envelope.iterations !== 'number' ||
      typeof envelope.saltHex !== 'string' ||
      typeof envelope.ivHex !== 'string' ||
      typeof envelope.ciphertextHex !== 'string'
    ) {
      throw new Error('Unsupported or mismatched vault envelope.');
    }

    const webCrypto = requireWebCrypto();
    const salt = hexToBytes(envelope.saltHex);
    const iv = hexToBytes(envelope.ivHex);
    const ciphertext = hexToBytes(envelope.ciphertextHex);
    const key = await this.deriveVaultKey(
      passphrase,
      salt,
      envelope.iterations
    );

    const plaintext = await webCrypto.subtle.decrypt(
      {
        name: 'AES-GCM',
        iv,
        additionalData: this.associatedData(gameId, playerId),
        tagLength: 128,
      },
      key,
      ciphertext
    );
    return JSON.parse(
      new TextDecoder().decode(plaintext)
    ) as LocalKeyMaterial;
  }
}
