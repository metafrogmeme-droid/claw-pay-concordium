# Threat model v0.1

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Product:** Claw Pay for Concordium
**Version:** 0.1
**Date:** 20 Nov 2026 (Europe/Amsterdam)
**Network:** Concordium testnet only. No mainnet, no real funds.

This is a working model for the draft PRs. It will be revised as the vault, allowlist, receipts and x402 flow land.

**Changes since v0 (PR 1):**
- **New trust boundaries:** the operator box, CI and dependencies, and the verifier's node.
- **New assets:** module provenance and repository/CI integrity.
- **Security invariants**, each mapped to the PR that tests it.
- **New threats:** cap windows, arithmetic, callbacks, stale allowlists, in-limit misuse, pause latency, supply chain, secret leakage, wrong network, finality and module provenance.
- **Open decisions** for the later PRs.

No trust assumption is added and the scope is unchanged.

## Trust boundaries

- **Owner:** identity-backed account that funds the vault and alone may change caps, the allowlist and the pause.
- **Agent:** a key that may only call `pay`. It cannot change rules, even if compromised.
- **Providers:** payment destinations. Only Active Agent Registry agents whose card hash matches the allowlist are valid.
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

Each invariant becomes one or more contract tests in the PR listed. PR 1 adds only the contract skeleton (owner recorded at init, read-only `owner` view) and its tests.

| ID | Invariant | Tested in |
|---|---|---|
| INV-1 | Only the owner can change caps, the allowlist or the pause. | PR 2, PR 3 |
| INV-2 | The agent key can successfully call only `pay`. | PR 2 |
| INV-3 | Every payment is at most the per-tx cap. | PR 2 |
| INV-4 | Payments within one cap window total at most the per-day cap. | PR 2 |
| INV-5 | While the vault is paused, `pay` fails. | PR 2 |
| INV-6 | Each `nonce` and each `invoice_hash` is accepted at most once. | PR 2, PR 3 |
| INV-7 | `pay` succeeds only to allowlisted providers. | PR 3 |
| INV-8 | Every successful `pay` emits exactly one `Receipt` linked to the hash of the receipt before it. A failed `pay` emits nothing and leaves state unchanged. | PR 3 |

## Threats and mitigations

| Threat | What it looks like | Mitigation |
|---|---|---|
| Agent key compromise | An attacker uses the agent key to drain funds or change policy. | Loss is capped at one day's limit (see cap-window boundary). The agent key cannot change rules, the allowlist or the pause. Only `pay` is allowed. |
| Limit bypass | A payment exceeds the per-tx or per-day cap, or ignores a pause. | Caps, allowlist and pause are enforced in the contract, not in the agent. |
| Replay | A valid `pay` is submitted twice, or an old invoice is reused. | `nonce` and `invoice_hash` are checked on chain. Spend-policy, replay-guard and capped-signer logic in the client are a second layer, not the source of truth. |
| Provider spoofing | Payment is sent to an unapproved or impersonated provider. | Allowlist of Active Agent Registry agents whose card hash matches. Badge check in PR 4. |
| Receipt forgery | A fake receipt is presented off chain. | Receipts are contract events. The verifier rebuilds the chain from chain events alone. |
| Cap-window boundary | With a fixed calendar-day window, a compromised agent spends the full daily cap just before the boundary and again just after it. That is up to 2× the daily cap in a short time. | PR 2 picks the window. A rolling 24-hour window keeps the worst case at 1×. A fixed window must state the 2× worst case here and in the docs. Boundary tests either way. |
| Amount arithmetic | A running total or cap check overflows and wraps, letting a payment through. | Checked arithmetic on amounts and totals. A failed check rejects the payment. Tests at the maximum amount. |
| Callbacks | A payment target runs code that calls back into the vault before its state is updated. | Update spent totals, nonce and receipt state before transferring. On Concordium, a transfer to an account address runs no code. Whether a provider may be a contract is an open decision. |
| Stale allowlist | A provider is revoked in the Agent Registry, or its card changes, after it was allowlisted. | The owner removes or re-verifies providers. PR 4 decides whether the badge and card hash are checked when a provider is added or on every `pay`. Until then this is residual risk. |
| In-limit misuse | A compromised agent pays allowlisted providers within the caps, for example a colluding provider. | Loss is bounded by the caps and the allowlist. The owner can pause. Every payment leaves a public receipt. |
| Pause latency | The owner pauses after spotting a compromise, but agent transactions already submitted finalize first. | Those transactions are still bounded by the caps. Residual risk. |
| Supply-chain compromise | A malicious crate or npm package, a tampered tool binary or a compromised CI action runs in the build. | Lockfiles are committed and enforced in CI (`--locked`, `npm ci`). npm install scripts are disabled. Dependencies are few and exactly pinned. CI uses first-party GitHub actions only, read-only permissions and no secrets. `cargo-concordium` is pinned and checked against its sha256. The gitleaks binary is version-pinned but not yet checksum-verified (follow-up). |
| Secret leakage | A key, seed phrase or wallet export is committed or printed in logs. | gitleaks runs on every push and pull request over the full history. `.gitignore` covers key files and wallet exports. Keys are loaded from environment variables on the operator box only. CI and development environments hold no keys. |
| Wrong network | The client is pointed at mainnet by mistake. | The client refuses any network other than `testnet` (`assertTestnet`, wired in at start-up in PR 5). Throwaway keys must never be funded on mainnet. |
| Unfinalized receipts | The verifier counts a receipt from a block that is later dropped. | The verifier reads finalized blocks only. |
| Module provenance | The module deployed on testnet is not the one built from the reviewed commit. | Publish the module reference with the source commit. PR 6 considers a `cargo-concordium` verifiable build on the operator box. |

## Open decisions

These are for Patrick. None of them changes the scope, and each is settled in the PR named.

- **Cap window (PR 2):** rolling 24 hours or a fixed calendar day. Rolling keeps "loss is capped at one day's limit" exact. A fixed window allows up to 2× across a boundary.
- **Upgradeability (PR 2):** an `upgrade` entrypoint would be an owner power equal to changing every rule. Recommendation: no upgrade entrypoint for the hackathon; redeploy instead.
- **Owner and `pay` (PR 2):** whether the owner may also call `pay`, or only the agent.
- **Provider type (PR 3):** accounts only, or contracts too. Accounts only removes callback risk.
- **Registry check timing (PR 4):** when a provider is added, or on every `pay`.
- **Sponsored fees (PR 4):** how the x402 seller flow limits fee griefing against the sponsor.

## Open verification

- Whether vault payments fit the standard x402 `exact` scheme is unverified until the PR 4 seller spike.

## Out of scope for this entry

Mainnet, real funds, KYC, paid services, EVM and PayPal. Admin, keeper or off-chain operator compromise beyond the owner's documented powers is also out of scope for this version.

## Residual risk

A compromised owner key can change caps, the allowlist and the pause. Daily caps bound loss from an agent-key compromise, but they do not bound owner-key compromise. Testnet keys must stay throwaway, uncommitted, and mode 600 on the operator box.

Within the caps, a compromised agent key can still pay allowlisted providers until the owner pauses, and transactions already submitted may finalize after the pause. Until PR 4, a provider revoked in the Agent Registry stays payable until the owner removes it. Pinning and lockfiles reduce supply-chain risk but do not remove it.
