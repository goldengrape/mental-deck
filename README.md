# Mental Deck

**Mental Deck is a cryptographically enforced virtual deck of physical game pieces.**

The v0.10 architecture deliberately guarantees **cards, not sportsmanship**: Core protects card secrecy, conservation, ownership/control, authentic disclosure authorization, fair random selection, and replay-safe committed state. Game rules such as Bridge follow-suit, UNO Wild Draw Four eligibility, or Old Maid pair validity live in optional **Rule Advisors** and are not cryptographic authorization proofs.

> [!WARNING]
> **Crypto status is still `SIMULATION_ONLY`.** v0.10 simplifies the *game-rule* trust boundary; it does **not** relax the requirement for real joint-key encryption, verifiable shuffles, and distributed decryption. Production adversarial play remains blocked until the browser/WASM crypto-provider gate is completed.

See [SECURITY.md](./SECURITY.md) for the production security boundary.

## Status

| Area | Status | Notes |
|---|---|---|
| v0.10 Physical Deck contracts | Implemented | `SignedMechanicalIntent`, `SignedPublicGameEvent`, `ControllerGrant`, unified `StateLedger` |
| `mental-deck-game/v1` | Implemented | Bounded JSON Schema + manifest validation |
| Generic Coordinator | Implemented | No Old Maid / UNO / Bridge authorization branches |
| Old Maid reference package | Implemented | Exercises blind random draw and rule-independence |
| UNO reference package | Implemented | Exercises second-game pluggability and public events |
| Bridge controller spike | Implemented | Exercises owner-authorized action-scoped delegation |
| Minimal-disclosure audit envelope | Implemented | Transition commitments; not full cryptographic proof replay |
| Quiet Table UI cutover | Partial | Existing polished Old Maid UI still uses the legacy compatibility path |
| Production Mental Poker crypto | **Blocked** | Real joint-key encryption, ZK shuffle proof, distributed decrypt/DLEQ still required |

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

Rule Advisor output is derived outside the Core state hash and cannot grant controller rights, reveal cards, or authorize a move.

## Standardized game packages

The repository contains the v0.10 game-package schema:

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

Adding UNO and Bridge does **not** add game-specific imports or rule branches to the v0.10 Generic Coordinator.

## Security-relevant v0.10 components

- `src/plugins/gamePackageHost.ts`
  - validates the bounded manifest vocabulary;
  - expands roster-dependent Zone templates;
  - locks deck/zones/setup/mechanical policy/event schemas into `security_definition_hash`;
  - keeps non-TCB package-release identity separate via `package_release_hash`.
- `src/core/mechanicalPolicy.ts`
  - accepts only manifest-declared actions and parameters;
  - resolves Zone templates;
  - keeps `CONTROLLED` and `BLIND_RANDOM` distinct.
- `src/core/controllerEngine.ts`
  - owner remains owner;
  - delegated controller rights are owner-authorized and `allowed_action_ids` scoped;
  - controller rights never change visibility.
- `src/protocol/physicalDeckCoordinator.ts`
  - has no Old Maid / UNO / Bridge imports;
  - verifies player key-ownership proofs and signed intents/events;
  - never calls Rule Advisor for Core authorization;
  - commits mechanical actions and public game events into the same StateLedger order.
- `src/client/gameClientRuntime.ts`
  - signs only manifest-declared mechanical actions and public events;
  - remains viewer-local and does not create Core authority by itself.
- `src/protocol/physicalDeckAudit.ts`
  - exports minimal-disclosure transition commitments without private CardRef vectors or local knowledge.

The pre-v0.10 `GameCoordinator` remains temporarily for the existing Quiet Table visual prototype and historical regressions. It is a **compatibility path**, not the target generic architecture. UI cutover is intentionally separated from the Core migration so the security refactor does not silently break the visual prototype.

## Mechanical legality vs. game-rule legality

Example: Bridge.

```text
South owns/controls ♥7 and plays it to CurrentTrick
    -> mechanically valid if the CardRef is real and controlled

South still holds a spade and therefore should have followed suit
    -> Rule Advisor may report MUST_FOLLOW_SUIT
    -> no hidden-predicate ZK proof is required by Core

North attempts to play East's ♥7 without a ControllerGrant
    -> Core rejects: no controller authority
```

The same split applies to UNO Wild Draw Four and Old Maid pair claims.

## Random selection and disclosure boundaries

For a hidden unordered source Zone, a caller cannot choose a hidden CardRef and relabel it as random. The intended path is:

```text
BLIND_RANDOM request
    -> multiparty random contribution protocol
    -> RandomSelectionReceipt
    -> VERIFIED_RANDOM ResolvedSelection
    -> Core validates source commitment / state / workflow / epoch / one-time use
    -> move commits
```

Likewise, a reveal operation first creates committed disclosure authorization. Production plaintext reconstruction and DLEQ-verified distributed decryption remain part of the real crypto-provider integration and are **not** supplied by the simulation provider.

## Current crypto hard gate

The simulation provider must be replaced by independently verifiable browser/WASM primitives for:

1. per-player asymmetric signing and key-ownership proofs;
2. joint-key compatible card encryption;
3. verifiable re-encryption shuffle;
4. partial decryption with proof of equality of discrete logarithms (DLEQ / Chaum-Pedersen family);
5. runtime deck size `1 <= N < 200` in the same production build;
6. independent-client transport for shuffle, randomness, and decrypt contributions.

The current DEV harness still generates some multi-party contributions in one process for protocol testing. No v0.10 rule simplification should be interpreted as making that production-secure.

`package_release_hash` is also currently a **development release commitment** over the manifest and declared module paths. Production package signing should bind the actual module and asset bytes.

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
- audit minimal disclosure and tamper rejection;
- static prohibition on concrete-game imports / Rule Advisor dependency inside the Generic Coordinator;
- declarative manifest-schema checks.

The in-app historical TDD runner remains a prototype subset and is not a substitute for CI-enforced executable security tests.

## References / 参考文献

The papers below are **design references**, not security certifications of the current code. In particular, citing ElGamal, Chaum-Pedersen, or verifiable-shuffle literature does not mean the `SIMULATION_ONLY` provider implements those constructions securely.

1. **Adi Shamir, Ronald L. Rivest, Leonard M. Adleman.** “Mental Poker.” In *The Mathematical Gardner*, pp. 37–43, 1981. DOI: https://doi.org/10.1007/978-1-4684-6686-7_5  
   Foundational statement of the mental-poker problem: fair card play between mutually distrustful remote participants.

2. **Shafi Goldwasser, Silvio Micali.** “Probabilistic Encryption & How to Play Mental Poker Keeping Secret All Partial Information.” *Proceedings of the 14th Annual ACM Symposium on Theory of Computing (STOC)*, pp. 365–377, 1982. DOI: https://doi.org/10.1145/800070.802212  
   Important early work connecting stronger cryptographic privacy notions with mental-poker-style protocols.

3. **Taher ElGamal.** “A Public Key Cryptosystem and a Signature Scheme Based on Discrete Logarithms.” *IEEE Transactions on Information Theory*, 31(4):469–472, 1985. DOI: https://doi.org/10.1109/TIT.1985.1057074  
   Reference point for the ElGamal family of discrete-log public-key encryption used by many re-encryption and mix-net constructions.

4. **David Chaum, Torben Pryds Pedersen.** “Wallet Databases with Observers.” In *Advances in Cryptology — CRYPTO ’92*, pp. 89–105, 1992. DOI: https://doi.org/10.1007/3-540-48071-4_7  
   Source of the Chaum-Pedersen proof technique commonly used to prove equality of discrete logarithms (DLEQ), relevant to verifiable partial decryption.

5. **C. Andrew Neff.** “A Verifiable Secret Shuffle and its Application to E-Voting.” *Proceedings of the 8th ACM Conference on Computer and Communications Security (CCS)*, pp. 116–125, 2001. DOI: https://doi.org/10.1145/501983.502000  
   A major verifiable-shuffle construction and useful background for proving that encrypted objects were permuted correctly without revealing the permutation.

6. **Stephanie Bayer, Jens Groth.** “Efficient Zero-Knowledge Argument for Correctness of a Shuffle.” In *Advances in Cryptology — EUROCRYPT 2012*, pp. 263–280, 2012. DOI: https://doi.org/10.1007/978-3-642-29011-4_17  
   Efficient zero-knowledge arguments for correctness of shuffles of homomorphic ciphertexts; directly relevant to the project’s future production shuffle-provider evaluation.

### Reference-to-project map

```text
Mental Poker                    -> problem / threat-model lineage
Goldwasser-Micali               -> secrecy of partial information
ElGamal                         -> joint-key / re-encryption design family
Chaum-Pedersen                  -> DLEQ-style decrypt-share verification
Neff / Bayer-Groth              -> verifiable re-encryption shuffle lineage
```

These references inform the architecture and the crypto-provider research gate. The implementation must still be reviewed against the exact security assumptions and proof requirements of whichever production primitive/provider is ultimately selected.
