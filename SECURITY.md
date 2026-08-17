# Security status

Mental Deck is currently a **protocol/UI simulation**, not a production-secure Mental Poker implementation.

## Hard gate

Production deployment for adversarial play is blocked until RMD-TASK-004 is complete and a real browser/WASM provider supplies and validates:

- per-player asymmetric signing and key ownership proofs;
- joint-key ElGamal-compatible encryption;
- verifiable re-encryption shuffle with zero-knowledge proof;
- distributed partial decryption with DLEQ / Chaum-Pedersen-style proofs;
- runtime deck size `1 <= N < 200` in the same build.

The current `src/crypto/cryptoProvider.ts` is explicitly `SIMULATION_ONLY`. It is useful for exercising protocol context, state transitions and failure behavior, but its shuffle/decrypt transcripts are **not** cryptographic proofs.

## Production block

The web shell refuses normal production rendering while `PRODUCTION_CRYPTO_AVAILABLE === false`.

The single-browser three-player setup is a development harness. It intentionally co-locates multiple simulated clients and a plaintext oracle so UI/state-machine work can continue. Those facilities must not become network APIs and must be removed from the production path when real distributed clients are introduced.

## Security boundaries already enforced

Even in simulation mode, the implementation should fail closed on protocol rules that do not depend on the future crypto provider:

- signed semantic-intent actor/base-state binding;
- mandatory key-ownership-proof presence;
- `BY_HANDLE` authorization for private Zones;
- `RANDOM` is not authorization by itself;
- `VERIFIED_RANDOM` requires an existing exact-context `RandomSelectionReceipt`;
- receipts are bound to source Zone commitment, workflow, parent state, selected CardRef + epoch and one-time consumption;
- non-owner GameViews do not receive complete hidden CardRef vectors;
- game-state-extension hash is recomputed at commit;
- disclosure authorization is committed before the simulation plaintext oracle is consulted.

## Reporting

Please report security issues privately to the repository owner rather than publishing an exploit before a fix is available.
