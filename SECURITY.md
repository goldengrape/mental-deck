# Security model

Mental Deck is currently a **trusted-coordinator prototype**, not a production zero-knowledge mental-poker implementation.

## Implemented security properties

- Semantic player intents are signed and verified with WebCrypto ECDSA P-256.
- Player key proof-of-possession uses ECDSA verification.
- SHA-256 operations fail closed if WebCrypto is unavailable.
- Random card selections require an authoritative, context-bound receipt and one-time consumption tracking.
- Atomic candidates and committed state snapshots are hash-checked before commit/append.
- Unauthorized viewers do not receive hidden-zone CardRef vectors from `StateLedger.projectGameView()`.
- Local vault encryption uses PBKDF2-SHA256 + AES-GCM.

## Prototype-only cryptography

The following are **simulations** and must not be represented as production cryptographic guarantees:

- joint/threshold deck encryption;
- re-encryption shuffle;
- zero-knowledge permutation proof;
- threshold partial decryption / DLEQ proof;
- independence from a trusted coordinator.

The coordinator currently retains a private CardRef-to-CardInstance mapping and receives player shuffle secrets. Therefore it can know card identities and is part of the trusted computing base.

## Before any untrusted multiplayer deployment

Replace the prototype shuffle/encryption layer with an audited mental-poker protocol where:

1. no coordinator receives player private keys;
2. no single party can recover the complete hidden card mapping;
3. shuffle proofs cryptographically prove permutation plus valid re-encryption;
4. partial decryptions are verifiably bound to participant public keys;
5. readiness/transport authentication is performed across the actual network boundary;
6. transcript verification can replay semantic state transitions, not only hash-chain integrity.

Until then, UI and documentation should use terms such as **prototype**, **trusted coordinator**, and **simulated shuffle proof**.
