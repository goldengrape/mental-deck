# Security status

Mental Deck v0.10 implements a **Physical Deck security model**: Core aims to make digital cards behave like authentic physical game pieces. It is **not** a cryptographic referee for every game rule.

> [!WARNING]
> The current cryptographic provider is still **`SIMULATION_ONLY`**. The architectural/security gates below are executable, but adversarial production play remains blocked until the real multi-client browser/WASM provider is complete.

## What the security boundary protects

Mental Deck Core is responsible for properties that physical cards naturally enforce:

- hidden cards are not disclosed to unauthorized viewers;
- CardRefs cannot be invented, duplicated, silently deleted or substituted;
- an actor can select a hidden handle only through valid control authority;
- delegated Zone control is owner-authorized and action-scoped;
- controller rights do not change ownership or visibility;
- blind access to another hidden unordered Zone is restricted to `BLIND_RANDOM -> VERIFIED_RANDOM` with exact-context receipt provenance;
- shuffle/randomness cannot be replaced by a client-selected hidden result;
- public/private disclosure is authorization-bound and plaintext delivery occurs only after that authorization is committed;
- signed intents/events bind actor, locked security definition and current state/version;
- mechanical actions, public game events and protocol transitions share one replay-safe StateLedger total order;
- public/audit projections must not expose private CardRef vectors, private keys, local knowledge or hidden CardRef-to-CardInstance mappings.

## What is intentionally **not** a cryptographic security guarantee

Game-rule compliance is outside the default TCB. Optional Rule Advisors / normal UI may warn, block friendly clients or calculate outcomes, but their output is not a Core proof or ACL input.

Examples:

- Bridge: following the led suit;
- UNO: whether Wild Draw Four is permitted by the player's hidden hand;
- Old Maid: whether two claimed discarded cards form a matching pair;
- ordinary turn/score/contract interpretation.

A malicious player may violate such a rule just as a person can violate a tabletop rule. That must **not** let the player see another private hand, manufacture a card, choose a supposedly random hidden card, or act with controller rights they do not possess.

Removing the Rule Advisor entirely must not weaken secrecy, conservation, control, disclosure authenticity, random provenance or replay protection.

## Current executable v0.10 boundaries

The compatibility-independent v0.10 path includes:

- `mental-deck-game/v1` bounded manifest vocabulary;
- `security_definition_hash` over physical/security-relevant definition material only;
- signed `SignedMechanicalIntent` and `SignedPublicGameEvent` gates;
- `CONTROLLED` vs `BLIND_RANDOM` source-access separation;
- fail-closed `RandomSelectionReceipt` provenance and one-time consumption;
- owner-authorized `ControllerGrant` with explicit `allowed_action_ids`;
- hidden stable CardRef suppression in player GameViews;
- one StateLedger order for mechanical/public/protocol transitions;
- minimal-disclosure v0.10 audit envelopes;
- static CI checks that `PhysicalDeckCoordinator` has no Old Maid/UNO/Bridge or Rule Advisor dependency.

The pre-v0.10 `GameCoordinator` and Quiet Table Old Maid UI are retained temporarily as a compatibility/visual-prototype path. They are not the new generic authorization architecture.

## Hard gate for adversarial production

Production deployment remains blocked until the independent crypto-provider work (v0.10 RMD-TASK-015) supplies and validates:

- per-player asymmetric signing and key-ownership proofs;
- joint-key-compatible card encryption;
- verifiable re-encryption shuffle with a real zero-knowledge proof;
- distributed partial decryption with DLEQ / Chaum-Pedersen-style proofs;
- runtime deck size `1 <= N < 200` in the same browser/WASM production build;
- independent client contribution transport rather than the current single-process simulation harness.

The current `src/crypto/cryptoProvider.ts` is explicitly `SIMULATION_ONLY`. Its shuffle/decrypt transcripts are not production cryptographic proofs.

## Production block

The existing web shell refuses normal production rendering while `PRODUCTION_CRYPTO_AVAILABLE === false`.

The current development environment may co-locate simulated player clients and development-only knowledge/oracle facilities so UI and protocol-state work can proceed. Those facilities must never become production network APIs or server-side hidden CardRef-to-CardInstance stores.

## Reporting

Please report security issues privately to the repository owner rather than publishing an exploit before a fix is available.
