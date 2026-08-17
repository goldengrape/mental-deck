# Mental Deck

A web prototype for **Mental Poker / hidden-card state protocols**, with Old Maid as the current reference game.

> [!WARNING]
> **Current crypto status: `SIMULATION_ONLY`.**  The repository exercises protocol state machines, selection provenance, privacy-preserving projections and UI flows, but it does **not** yet provide production-secure joint-key encryption, zero-knowledge shuffle proofs, or distributed DLEQ decryption. Production game rendering is intentionally blocked until the real browser/WASM crypto gate is completed.

See [SECURITY.md](./SECURITY.md) for the precise boundary.

## What is implemented

- generic `CardRef` / Zone state model;
- Privacy Pool before hidden allocation;
- deterministic selection ACLs;
- `SelectionSpec -> ResolvedSelection` separation;
- fail-closed `VERIFIED_RANDOM + RandomSelectionReceipt` provenance;
- hidden CardRef-vector suppression in non-owner GameViews;
- committed state hash chain and extension-hash verification;
- staged Old Maid `discard_pair` disclosure ordering;
- signed semantic intents in the simulation runtime;
- local encrypted vault using PBKDF2-SHA-256 + AES-GCM;
- Old Maid Quiet Table UI;
- CI security regression suite.

## Hard gate before adversarial deployment

A real provider must replace `src/crypto/cryptoProvider.ts` simulation mechanics with independently verifiable browser/WASM primitives for:

1. per-player signing and key ownership proofs;
2. joint-key compatible card encryption;
3. verifiable re-encryption shuffle;
4. partial decryption + DLEQ / Chaum-Pedersen proof;
5. runtime `1 <= N < 200` in the same build.

The single-process three-player harness currently co-locates simulated clients and a DEV-only plaintext oracle. That is useful for UI/state-machine work only.

## Run

```bash
bun install
bun run dev
```

## Verification

```bash
bun run lint
bun run test:security
bun run build
```

`test:security` is the CI-enforced hardening regression suite. The in-app historical TDD runner is a prototype subset and must not be interpreted as proof that every TDD-TEST-001..081 requirement is implemented.

## Architecture

```text
Game Client / UI Adapter
        |
Signed semantic intent
        v
Canonical game rules
        |
ResolvedSelection + evidence
        v
Mental Deck Core / Atomic Kernel
        |
Committed state hash chain
```

Old Maid is the reference plugin, not a reason for Core to learn card-game-specific rules. Further extraction of the Coordinator's Old Maid-specific workflow code into the generic canonical plugin runtime remains follow-up work.
