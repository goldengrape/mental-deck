# Mental Deck

**Mental Deck is a cryptographically enforced virtual deck of physical game pieces.**

The v0.10 architecture deliberately guarantees **cards, not sportsmanship**: Core protects secrecy, conservation, ownership/control, authentic disclosure, fair random selection and replay-safe state. Game rules such as Bridge follow-suit, UNO Wild Draw Four eligibility or Old Maid pair validity live in optional **Rule Advisors** and are not cryptographic authorization proofs.

> [!WARNING]
> **Crypto status is still `SIMULATION_ONLY`.** v0.10 simplifies the *game-rule* trust boundary; it does **not** relax the hard requirement for real joint-key encryption, verifiable shuffles and distributed decryption. Production adversarial play remains blocked until the browser/WASM crypto provider gate is completed.

See [SECURITY.md](./SECURITY.md) for the production security boundary.

## v0.10 model

```text
Game Package (mental-deck-game/v1)
  ├─ game.json                 physical tabletop only
  ├─ rules.*                   optional, Non-TCB
  ├─ client.*                  optional
  └─ ui.*                      optional
             |
             v
SignedMechanicalIntent / SignedPublicGameEvent
             |
             v
Mechanical Policy + Controller / Event gates
             |
             v
Mental Deck Core
  CardRef · Zones · CONTROLLED/BLIND_RANDOM
  conservation · visibility · scoped delegation
  random provenance · disclosure grants · replay safety
             |
             v
one committed StateLedger total order
```

Rule Advisor output is derived outside the Core state hash and cannot grant controller rights, reveal cards or authorize a move.

## Standardized game packages

The repository now contains a real JSON Schema:

- [`schemas/mental-deck-game-v1.schema.json`](./schemas/mental-deck-game-v1.schema.json)

Reference packages are sourced from standardized `game.json` files:

- [`src/plugins/oldMaid/game.json`](./src/plugins/oldMaid/game.json)
  - `discard_claim`: controlled move + public disclosure authorization
  - `draw_random_from_player(target)`: `BLIND_RANDOM -> VERIFIED_RANDOM`
  - `end_turn`: signed public game event
  - pair validity / recommended next target are advisory
- [`src/plugins/uno/game.json`](./src/plugins/uno/game.json)
  - controlled `play_card`
  - ordered `draw_card`
  - `choose_color` public event
  - Wild Draw Four hidden-hand legality is advisory
- [`src/plugins/bridge/game.json`](./src/plugins/bridge/game.json)
  - 4 x 13 physical deal
  - public trick play
  - owner-authorized, action-scoped Dummy hand delegation
  - follow-suit is viewer-local Rule Advisor logic

Adding UNO and Bridge did **not** add game-specific imports or branches to the v0.10 Generic Coordinator.

## Security-relevant v0.10 components

- `src/plugins/gamePackageHost.ts`
  - validates the bounded manifest vocabulary;
  - expands roster-dependent Zone templates;
  - locks deck/zones/setup/mechanical policy/event schemas into `security_definition_hash`;
  - keeps non-TCB module release identity separate via `package_release_hash`.
- `src/core/mechanicalPolicy.ts`
  - accepts only manifest-declared actions and parameters;
  - resolves Zone templates;
  - keeps `CONTROLLED` and `BLIND_RANDOM` distinct.
- `src/core/controllerEngine.ts`
  - owner remains owner;
  - delegated controller rights are owner-authorized and `allowed_action_ids` scoped;
  - controller rights never change visibility.
- `src/protocol/physicalDeckCoordinator.ts`
  - no Old Maid / UNO / Bridge imports;
  - verifies player key-ownership proofs and signed intents/events;
  - never calls Rule Advisor for Core authorization;
  - commits mechanical actions and public game events into the same StateLedger order.
- `src/protocol/physicalDeckAudit.ts`
  - exports minimal-disclosure transition commitments without private CardRef vectors or local knowledge.

The pre-v0.10 `GameCoordinator` remains temporarily for the existing Quiet Table visual prototype and historical regressions. It is a **compatibility path**, not the new generic architecture. UI cutover is intentionally separated from the Core migration so the security refactor does not silently break the visual prototype.

## Mechanical vs game-rule legality

Example: Bridge.

```text
Bob owns/controls ♥7 and plays it to CurrentTrick
    -> mechanically valid if the CardRef is real and controlled

Bob still holds a spade and therefore should have followed suit
    -> Rule Advisor may report MUST_FOLLOW_SUIT
    -> no hidden-predicate ZK proof is required by Core

Bob attempts to play Alice's ♥7
    -> Core rejects: no controller authority
```

The same split applies to UNO +4 and Old Maid pair claims.

## Current crypto hard gate

The simulation provider still needs replacement by independently verifiable browser/WASM primitives for:

1. per-player key ownership / signatures;
2. joint-key compatible card encryption;
3. verifiable re-encryption shuffle;
4. partial decryption with DLEQ / Chaum-Pedersen proof;
5. runtime `1 <= N < 200` in the same production build.

The current DEV harness still generates some multi-party contributions in one process for protocol testing. No v0.10 rule simplification should be interpreted as making that production-secure.

## Run

```bash
bun install
bun run dev
```

## Verification

```bash
bun run lint
bun run test:security
bun run test:v010
bun run build
```

`test:v010` exercises:

- Old Maid blind-random provenance and rule-independence;
- foreign CardRef rejection;
- unified StateLedger ordering for public events;
- `security_definition_hash` independence from Rule Advisor release paths;
- owner-authorized action-scoped controller grants;
- UNO through the same Generic Coordinator;
- Bridge Dummy-style delegated control;
- PoK rejection;
- audit minimal disclosure;
- static prohibition on game-specific imports / Rule Advisor dependency inside the Generic Coordinator;
- declarative manifest-schema checks.

The in-app historical TDD runner remains a prototype subset and is not a substitute for CI-enforced executable security tests.
