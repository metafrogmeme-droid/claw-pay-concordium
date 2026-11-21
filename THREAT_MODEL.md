# Threat model v0.2

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Product:** Claw Pay for Concordium
**Version:** 0.2
**Date:** 21 Nov 2026 (Europe/Amsterdam)
**Network:** Concordium testnet only. No mainnet, no real funds.

This is a working model for the draft PRs. It will be revised as the allowlist, receipts and x402 flow land.

## Changes

- **v0.2 (PR 2):**
  - Records Patrick's decisions of 21 Nov: a fixed UTC-day cap window, an immutable contract, and only the agent may pay.
  - Settles the provider type to accounts only.
  - Adds INV-9 (withdraw) and INV-10 (agent ≠ owner).
  - Marks the invariants PR 2 now tests.
  - Adds threats for nonce desync and for a contract with no upgrade path.
  - Adds the owner's `withdraw` power to the residual risk.
- **v0.1 (PR 1):** added trust boundaries for the operator box, CI and the verifier's node. Added security invariants, threats for cap windows, arithmetic, callbacks, stale allowlists, in-limit misuse, pause latency, supply chain, secret leakage, wrong network, finality and module provenance, and the open decisions.

No trust assumption has been added, and the scope is unchanged.

## Decisions

Patrick's decisions, 21 Nov 2026:

1. **Cap window: fixed UTC day.** The window id is block time ÷ 86 400 s, and the total resets at 00:00 UTC. Recomputing it from receipts is simple. The cost: up to 2× the daily cap can go out across midnight (see threats).
2. **Not upgradeable.** There is no upgrade entrypoint. To migrate, the owner pauses, withdraws to the owner account, and funds a new instance.
3. **Only the agent pays.** The owner manages rules, the pause and `withdraw`, but cannot call `pay`. The owner can never be made the agent. So every payment is an agent action and will leave a receipt (PR 3).

Settled by design in PR 2 (plan approved 21 Nov):

4. **Providers are account addresses.** `pay` and `withdraw` transfer only to accounts, which run no code. That removes callback risk.

## Trust boundaries

- **Owner:** identity-backed account that creates and funds the vault. It alone may change caps, the agent, the allowlist (PR 3) and the pause, and withdraw funds to its own account.
- **Agent:** a key that may only call `pay`. It cannot change rules, even if compromised. It is always a different account from the owner.
- **Providers:** payment destinations, which are account addresses. Only Active Agent Registry agents whose card hash matches the allowlist are valid (PR 3–4).
- **Chain:** `GuardVault` and its `Receipt` events are the source of truth. Off-chain logs are not.
- **Operator box:** the machine that holds the throwaway testnet keys (mode 600, loaded from environment variables). It runs every deploy and live testnet step. Development and CI environments hold no keys.
- **CI and dependencies:** GitHub Actions runners, crates.io, npm, and pinned tool binaries from GitHub releases. CI runs with read-only repository permissions and no secrets, and it never deploys.
- **Verifier and node:** the verifier rebuilds the receipt chain from a Concordium node's finalized data, so it trusts that node to report the chain honestly. Anyone can point it at a node they run. CCDExplorer is a convenience view, not the source of truth.

## Assets

- Test CCD held in `GuardVault`.
- The right to change spending rules.
- Public receipt integrity (hash-linked chain events).
- Agent and owner keys (throwaway testnet keys only).
- The deployed contract module matching the reviewed source.
- Repository and CI integrity: what is reviewed is what is built.

## Security invariants

Each invariant is covered by contract tests. The names below are the test names in `contracts/guard-vault/tests/guard_vault.rs`.

| ID | Invariant | Status |
|---|---|---|
| INV-1 | Only the owner can change caps, the agent, the pause or the allowlist, deposit, or withdraw. | Tested in PR 2 (`inv1_*`). Allowlist in PR 3. |
| INV-2 | The agent key can successfully call only `pay`; no other account can call `pay`. | Tested in PR 2 (`inv1_*`, `inv2_*`). |
| INV-3 | Every payment is at most the per-tx cap. | Tested in PR 2 (`inv3_*`, unit tests). |
| INV-4 | Payments within one UTC day total at most the daily cap. | Tested in PR 2 (`inv4_*`, unit tests), including the midnight edge. |
| INV-5 | While the vault is paused, `pay` fails. | Tested in PR 2 (`inv5_*`). |
| INV-6 | Each `nonce` and each `invoice_hash` is accepted at most once. | Tested in PR 2 (`inv6_*`). |
| INV-7 | `pay` succeeds only to allowlisted providers. | PR 3. |
| INV-8 | Every successful `pay` emits exactly one `Receipt` linked to the hash of the receipt before it. A failed `pay` emits nothing and leaves state unchanged. | Rollback tested in PR 2 (`inv8_*`). Receipts in PR 3. |
| INV-9 | `withdraw` is owner-only and pays only the owner's account. | Tested in PR 2 (`inv1_*`, `inv9_*`). |
| INV-10 | The agent is never the owner, at init or after `set_agent`. | Tested in PR 2 (`inv10_*`). |

## Threats and mitigations

| Threat | What it looks like | Mitigation |
|---|---|---|
| Agent key compromise | An attacker uses the agent key to drain funds or change policy. | Loss is capped at the daily cap per UTC day: up to 2× across midnight (see cap-window boundary). The agent key cannot change rules, the allowlist or the pause. Only `pay` is allowed. The owner pauses and rotates the key with `set_agent`. |
| Limit bypass | A payment exceeds the per-tx or per-day cap, or ignores a pause. | Caps, allowlist and pause are enforced in the contract, not in the agent. |
| Replay | A valid `pay` is submitted twice, or an old invoice is reused. | `pay` must use the next `nonce` in sequence and an `invoice_hash` never paid before. Both are checked on chain. Spend-policy, replay-guard and capped-signer logic in the client are a second layer, not the source of truth. |
| Provider spoofing | Payment is sent to an unapproved or impersonated provider. | Allowlist of Active Agent Registry agents whose card hash matches (PR 3). Badge check in PR 4. |
| Receipt forgery | A fake receipt is presented off chain. | Receipts are contract events. The verifier rebuilds the chain from chain events alone. |
| Cap-window boundary | The window is a fixed UTC day (decision 1). A compromised agent spends the full daily cap just before 00:00 UTC and again just after, which is 2× the daily cap within a millisecond. | Accepted and documented. The worst case is bounded at 2× the daily cap across midnight. The test `inv4_midnight_edge_allows_two_caps_within_a_millisecond` shows the edge. Owners should size the daily cap with that in mind. |
| Amount arithmetic | A running total or cap check overflows and wraps, letting a payment through. | Checked arithmetic on amounts, totals and the nonce. An overflow rejects the call. Unit-tested at `Amount::MAX`. |
| Callbacks | A payment target runs code that calls back into the vault before its state is updated. | `pay` updates the nonce, totals and paid invoices before transferring. `pay` and `withdraw` transfer only to account addresses, which run no code (decision 4). |
| Stale allowlist | A provider is revoked in the Agent Registry, or its card changes, after it was allowlisted. | The owner removes or re-verifies providers. PR 4 decides whether the badge and card hash are checked when a provider is added or on every `pay`. Until then this is residual risk. |
| In-limit misuse | A compromised agent pays allowlisted providers within the caps, for example a colluding provider. | Loss is bounded by the caps and the allowlist. The owner can pause. Every payment leaves a public receipt. |
| Pause latency | The owner pauses after spotting a compromise, but agent transactions already submitted finalize first. | Those transactions are still bounded by the caps. Residual risk. |
| Nonce desync | The agent client loses track of the next nonce, or two payments race with the same nonce. | Fails closed: the wrong nonce is rejected (`InvalidNonce`), with no state change and no payment. The client reads `next_nonce` from `view` and retries. |
| No upgrade path | A bug is found in the deployed contract and cannot be patched in place (decision 2). | The owner pauses, withdraws everything (`withdraw` works while paused) and funds a fixed instance. `withdraw` and `set_paused` are covered by tests. |
| Supply-chain compromise | A malicious crate or npm package, a tampered tool binary or a compromised CI action runs in the build. | Lockfiles are committed and enforced in CI (`--locked`, `npm ci`). npm install scripts are disabled. Dependencies are few and exactly pinned. CI uses first-party GitHub actions only, read-only permissions and no secrets. `cargo-concordium` is pinned and checked against its sha256. The gitleaks binary is version-pinned but not yet checksum-verified (follow-up). |
| Secret leakage | A key, seed phrase or wallet export is committed or printed in logs. | gitleaks runs on every push and pull request over the full history. `.gitignore` covers key files and wallet exports. Keys are loaded from environment variables on the operator box only. CI and development environments hold no keys. |
| Wrong network | The client is pointed at mainnet by mistake. | The client refuses any network other than `testnet` (`assertTestnet`, wired in at start-up in PR 5). Throwaway keys must never be funded on mainnet. |
| Unfinalized receipts | The verifier counts a receipt from a block that is later dropped. | The verifier reads finalized blocks only. |
| Module provenance | The module deployed on testnet is not the one built from the reviewed commit. | Publish the module reference with the source commit. PR 6 considers a `cargo-concordium` verifiable build on the operator box. |

## Open decisions

These are for Patrick, and each is settled in the PR named:

- **Registry check timing (PR 4):** check a provider when it is added, or on every `pay`.
- **Sponsored fees (PR 4):** how the x402 seller flow limits fee griefing against the sponsor.

## Open verification

- Whether vault payments fit the standard x402 `exact` scheme is unverified until the PR 4 seller spike.

## Out of scope for this entry

Mainnet, real funds, KYC, paid services, EVM and PayPal. Admin, keeper or off-chain operator compromise beyond the owner's documented powers is also out of scope for this version.

## Residual risk

A compromised owner key can do everything the owner can. It can change caps, rotate the agent and pause. It can also withdraw the whole vault balance: `withdraw` pays only the owner's account, but the attacker then controls that account. Caps bound loss from an agent-key compromise, not from an owner-key compromise. Testnet keys must stay throwaway, uncommitted, and mode 600 on the operator box.

Within the caps, a compromised agent key can still pay allowlisted providers until the owner pauses. That is up to 2× the daily cap across midnight, and transactions already submitted may finalize after the pause. Until PR 4, a provider revoked in the Agent Registry stays payable until the owner removes it. Pinning and lockfiles reduce supply-chain risk but do not remove it.
