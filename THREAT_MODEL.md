# Threat model v0.4

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Product:** Claw Pay for Concordium
**Version:** 0.4
**Date:** 21 Nov 2026 (Europe/Amsterdam)
**Network:** Concordium testnet only. No mainnet, no real funds.

This is a working model for the draft PRs. It will be revised as the badge check, x402 flow and client land.

## Changes

- **v0.4 (PR 3b):**
  - The receipt verifier (`packages/verifier`) re-checks INV-8 off chain, and replays the rules to re-check INV-2 to INV-7 from events alone.
  - Adds the verifier's limits. Notes that the live export, which reads finalized blocks only, arrives in PR 5.
- **v0.3 (PR 3a):**
  - Records decisions 5 (check the registry when a provider is added and on every `pay`) and 6 (pay the registry `agent_wallet` only). This closes the registry-timing open decision.
  - INV-7 and the receipt part of INV-8 are now tested. Adds INV-11 (payee).
  - Adds threats for a wrong registry address, registry outage, wallet rotation, card changes and receipt splicing.
- **v0.2 (PR 2):**
  - Records Patrick's decisions of 21 Nov: a fixed UTC-day cap window, an immutable contract, and only the agent may pay.
  - Settles the provider type to accounts only.
  - Adds INV-9 and INV-10, plus threats for nonce desync and a contract with no upgrade path.
  - Adds the owner's `withdraw` power to the residual risk.
- **v0.1 (PR 1):** trust boundaries, invariants, the first set of threats, and the open decisions.

No trust assumption has been added beyond trusting the official CIS-8004 registry, which `SCOPE.md` already names as the source of provider verification. The scope is unchanged.

## Decisions

Patrick's decisions, 21 Nov 2026:

1. **Cap window: fixed UTC day.** The window id is block time ÷ 86 400 s, and the total resets at 00:00 UTC. Recomputing it from receipts is simple. The cost: up to 2× the daily cap can go out across midnight (see threats).
2. **Not upgradeable.** There is no upgrade entrypoint. To migrate, the owner pauses, withdraws to the owner account, and funds a new instance.
3. **Only the agent pays.** The owner manages rules, the pause, the allowlist and `withdraw`, but cannot call `pay`. The owner can never be made the agent. So every payment is an agent action with a receipt.
4. **Providers are paid at account addresses.** `pay` and `withdraw` transfer only to accounts, which run no code. That removes callback risk. (Settled by the PR 2 plan.)
5. **Registry check when added and on every `pay`.** The vault calls the registry's `agentOf` in `add_provider` and again in every `pay`. A provider revoked or re-carded in the registry is refused at once.
6. **Payout to `agent_wallet` only.** Payments go to the wallet the registry reports at payment time. The spec calls it the agent's payment address, and setting it needs a signature from that wallet. If no wallet is set, `pay` is refused.

## Trust boundaries

- **Owner:** identity-backed account that creates and funds the vault. It alone may change caps, the agent, the allowlist and the pause, and withdraw funds to its own account.
- **Agent:** a key that may only call `pay`. It cannot change rules, even if compromised. It is always a different account from the owner.
- **Providers:** CIS-8004 Agent Registry agents that the owner allowlisted with an approved card hash. The vault re-checks each one against the registry on every payment.
- **Agent Registry:** the CIS-8004 contract named at init. The vault trusts its replies about status, card hash and wallet. Its address cannot change for the vault's lifetime.
- **Chain:** `GuardVault` and its events are the source of truth. Off-chain logs are not.
- **Operator box:** the machine that holds the throwaway testnet keys (mode 600, loaded from environment variables). It runs every deploy and live testnet step, and confirms the official registry address. Development and CI environments hold no keys.
- **CI and dependencies:** GitHub Actions runners, crates.io, npm, and pinned tool binaries from GitHub releases. CI runs with read-only repository permissions and no secrets, and it never deploys.
- **Verifier and node:** the verifier rebuilds the receipt chain from a Concordium node's finalized data, so it trusts that node to report the chain honestly. Anyone can point it at a node they run. CCDExplorer is a convenience view, not the source of truth.

## Assets

- Test CCD held in `GuardVault`.
- The right to change spending rules and the allowlist.
- Public receipt integrity (hash-linked chain events).
- Agent and owner keys (throwaway testnet keys only).
- The deployed contract module matching the reviewed source.
- Repository and CI integrity: what is reviewed is what is built.

## Security invariants

Each invariant is covered by contract tests. The names below are the test names in `contracts/guard-vault/tests/guard_vault.rs`.

| ID | Invariant | Status |
|---|---|---|
| INV-1 | Only the owner can change caps, the agent, the pause or the allowlist, deposit, or withdraw. | Tested (`inv1_*`). |
| INV-2 | The agent key can successfully call only `pay`; no other account can call `pay`. | Tested (`inv1_*`, `inv2_*`). |
| INV-3 | Every payment is at most the per-tx cap. | Tested (`inv3_*`, unit tests). |
| INV-4 | Payments within one UTC day total at most the daily cap. | Tested (`inv4_*`, unit tests), including the midnight edge. |
| INV-5 | While the vault is paused, `pay` fails. | Tested (`inv5_*`). |
| INV-6 | Each `nonce` and each `invoice_hash` is accepted at most once. | Tested (`inv6_*`). |
| INV-7 | `pay` succeeds only for a provider that is allowlisted and, at that moment, Active in the registry with the approved card hash. | Tested (`inv7_*`). |
| INV-8 | Every successful `pay` logs exactly one `Receipt`. Its hash is the SHA-256 of its body, and its `prev_hash` is the previous receipt's hash. A failed `pay` logs nothing and changes no state. | Tested (`inv8_*`, `receipt_event_layout_is_tag_body_hash`). Re-checked off chain by `packages/verifier` against the golden fixture (`golden_fixture_matches_contract`). |
| INV-9 | `withdraw` is owner-only and pays only the owner's account. | Tested (`inv1_*`, `inv9_*`). |
| INV-10 | The agent is never the owner, at init or after `set_agent`. | Tested (`inv10_*`). |
| INV-11 | A payment goes only to the `agent_wallet` that the registry currently reports for the provider. | Tested (`inv11_*`). |

## Threats and mitigations

| Threat | What it looks like | Mitigation |
|---|---|---|
| Agent key compromise | An attacker uses the agent key to drain funds or change policy. | Loss is capped at the daily cap per UTC day: up to 2× across midnight (see cap-window boundary). It can only go to allowlisted, registry-verified providers. The agent key cannot change rules, the allowlist or the pause. The owner pauses and rotates the key with `set_agent`. |
| Limit bypass | A payment exceeds the per-tx or per-day cap, or ignores a pause. | Caps, allowlist and pause are enforced in the contract, not in the agent. |
| Replay | A valid `pay` is submitted twice, or an old invoice is reused. | `pay` must use the next `nonce` in sequence and an `invoice_hash` never paid before. Both are checked on chain. Spend-policy, replay-guard and capped-signer logic in the client are a second layer, not the source of truth. |
| Provider spoofing | Payment is sent to an unapproved or impersonated provider. | Only allowlisted registry agents can be paid. On every payment, the registry must report the agent Active with the approved card hash, and the money goes to its registered wallet. Badge check in PR 4. |
| Receipt forgery | A fake receipt is presented off chain. | Receipts are contract events. Each hash covers the previous one, and the head is in contract state. `claw-pay-verify` rebuilds the chain from the vault's events alone: it recomputes every hash, follows the links, replays the owner's rules against every payment, and requires the chain to end at the contract's head. A forged chain that is consistent with itself still fails the rule replay or the head check. |
| Receipt splicing | Receipts from another vault are mixed into this vault's chain. | The vault's own address is part of every hashed body, so foreign receipts fail the hash or link check. |
| Cap-window boundary | The window is a fixed UTC day (decision 1). A compromised agent spends the full daily cap just before 00:00 UTC and again just after, which is 2× the daily cap within a millisecond. | Accepted and documented. The worst case is bounded at 2× the daily cap across midnight. The test `inv4_midnight_edge_allows_two_caps_within_a_millisecond` shows the edge. Owners should size the daily cap with that in mind. |
| Amount arithmetic | A running total or cap check overflows and wraps, letting a payment through. | Checked arithmetic on amounts, totals and the nonce. An overflow rejects the call. Unit-tested at `Amount::MAX`. |
| Callbacks | A payment target or the registry runs code that calls back into the vault mid-payment. | The registry is queried read-only, before any state change. `pay` updates state before transferring. Transfers go only to account addresses, which run no code. A callback would arrive with the vault as sender and fail every role check. |
| Wrong registry address | The owner initializes the vault with a fake or wrong "registry", which approves any agent. | The registry address is an init parameter. The owner must use the official CIS-8004 testnet instance, confirmed on the operator box: the address could not be confirmed from the build environment. `Initialized` logs the address, and `view` shows it, so anyone can check it. A wrong address means redeploying, because the vault is immutable. |
| Registry outage or change | The registry rejects, changes its reply format, or is unavailable. | Fails closed: `add_provider` and `pay` reject with `RegistryQueryFailed`, and no money moves. The owner can still pause and withdraw. |
| Provider wallet rotation | The provider changes its `agent_wallet` in the registry. | Payments follow the registry (decision 6). Setting a wallet requires a signature from that wallet, and each receipt records the payee. An attacker would need the provider's registry ownership and a new wallet key. |
| Card change | The provider replaces its agent card, so the registry hash changes. | Fails closed (`CardHashMismatch`) until the owner reviews the new card and re-adds the provider with its hash. |
| Stale allowlist | A provider is revoked in the registry after it was allowlisted. | Refused at the next `pay` (`ProviderNotActive`), because the registry is checked on every payment (decision 5). |
| In-limit misuse | A compromised agent pays allowlisted providers within the caps, for example a colluding provider. | Loss is bounded by the caps and the allowlist. The owner can pause. Every payment leaves a public receipt. |
| Pause latency | The owner pauses after spotting a compromise, but agent transactions already submitted finalize first. | Those transactions are still bounded by the caps. Residual risk. |
| Nonce desync | The agent client loses track of the next nonce, or two payments race with the same nonce. | Fails closed: the wrong nonce is rejected (`InvalidNonce`), with no state change and no payment. The client reads `next_nonce` from `view` and retries. |
| No upgrade path | A bug is found in the deployed contract and cannot be patched in place (decision 2). | The owner pauses, withdraws everything (`withdraw` works while paused) and funds a fixed instance. `withdraw` and `set_paused` are covered by tests. |
| Mock registry deployed | The test-only `mock-agent-registry`, which anyone can rewrite, is used as the registry. | It is marked test-only in its crate docs, README and package description. It is never part of a deploy, and the operator box uses the official registry address (see wrong registry address). |
| Supply-chain compromise | A malicious crate or npm package, a tampered tool binary or a compromised CI action runs in the build. | Lockfiles are committed and enforced in CI (`--locked`, `npm ci`). npm install scripts are disabled. Dependencies are few and exactly pinned. CI uses first-party GitHub actions only, read-only permissions and no secrets. `cargo-concordium` is pinned and checked against its sha256. The gitleaks binary is version-pinned but not yet checksum-verified (follow-up). |
| Secret leakage | A key, seed phrase or wallet export is committed or printed in logs. | gitleaks runs on every push and pull request over the full history. `.gitignore` covers key files and wallet exports. Keys are loaded from environment variables on the operator box only. CI and development environments hold no keys. |
| Wrong network | The client is pointed at mainnet by mistake. | The client refuses any network other than `testnet` (`assertTestnet`, wired in at start-up in PR 5). Throwaway keys must never be funded on mainnet. |
| Unfinalized receipts | The verifier counts a receipt from a block that is later dropped. | The live exporter (PR 5) reads finalized blocks only. The verifier checks whatever events file it is given, so the file must come from a node the reader trusts. |
| Module provenance | The module deployed on testnet is not the one built from the reviewed commit. | Publish the module reference with the source commit. PR 6 considers a `cargo-concordium` verifiable build on the operator box. |

## Open decisions

These are for Patrick, and both are settled in PR 4:

- **Badge:** what the "Verified by Concordium" badge is technically, and how the vault or client should check it. The CIS-8004 spec does not define it.
- **Sponsored fees:** how the x402 seller flow limits fee griefing against the sponsor.

## Open verification

- Whether vault payments fit the standard x402 `exact` scheme is unverified until the PR 4 seller spike.
- The official CIS-8004 registry address on testnet must be confirmed on the operator box before deploy.

## What the verifier cannot check

`claw-pay-verify` sees only the vault's events. These parts happened on chain inside the vault's own transaction, and the verifier relies on that:
- the registry's answer at payment time, which the vault checked with `agentOf`,
- that the payee was the registry's `agent_wallet`, which the vault read in the same call,
- the CCD transfer itself, which happens in the same transaction as the receipt event, so both happened or neither did.

It also checks only the events file it is given, so where that file came from matters (see unfinalized receipts).

## Out of scope for this entry

Mainnet, real funds, KYC, paid services, EVM and PayPal. Admin, keeper or off-chain operator compromise beyond the owner's documented powers is also out of scope for this version.

## Residual risk

A compromised owner key can do everything the owner can. It can change caps, rotate the agent, pause, and allowlist providers. It can also withdraw the whole vault balance: `withdraw` pays only the owner's account, but the attacker then controls that account. Caps bound loss from an agent-key compromise, not from an owner-key compromise. Testnet keys must stay throwaway, uncommitted, and mode 600 on the operator box.

The vault trusts the registry named at init. A compromised or wrong registry could approve any agent and wallet. Caps and the pause still bound the loss per day.

Within the caps, a compromised agent key can still pay allowlisted providers until the owner pauses. That is up to 2× the daily cap across midnight, and transactions already submitted may finalize after the pause. Pinning and lockfiles reduce supply-chain risk but do not remove it.
