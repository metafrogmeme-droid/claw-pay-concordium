# Threat model v0.9

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Product:** Claw Pay for Concordium
**Version:** 0.9
**Date:** 22 Nov 2026 (Europe/Amsterdam)
**Network:** Concordium testnet only. No mainnet, no real funds.

This is a working model for the draft PRs. It will be revised as the x402 flow and client land.

## Changes

- **v0.9 (PR 5c):**
  - The owner's testnet CLI is in `packages/owner-cli` (`claw-pay-owner`).
  - Every state-changing command is a dry run unless `--send`, and a rejected dry run can't be sent.
  - Deploy checks the module reference against the chain's.
  - Init needs an explicit registry.
  - The owner key gets the same file rules as the agent key (`CLAW_PAY_OWNER_KEY_FILE`).
  - Adds the "operator mistake" threat.
- **v0.8 (PR 5b):**
  - The live connection layer is in `packages/node-adapter`:
    - a node guard that refuses any node whose genesis block isn't testnet's,
    - the vault-view decoder,
    - `VaultChain` and `AgentChain` on gRPC,
    - `claw-pay-export`, which exports finalized events with the view at the same block,
    - reconciling the local receipt log against the chain.
  - The agent client now uses the vault's own `spent_today` as a floor under its local daily total.
  - Adds threats for a node that lies or omits events, and for an incomplete export range.
- **v0.7 (PR 5a):**
  - The agent client's second layer is implemented in `packages/agent-client`:
    - spend-policy `decide`,
    - replay-guard,
    - capped-signer, the only holder of the agent key,
    - a hash-linked local receipt log.
  - `assertTestnet` is wired in at start-up. The agent key is loaded from a mode-600 testnet wallet export named by `CLAW_PAY_AGENT_KEY_FILE`.
  - The "seller names another provider" mitigation is implemented: the policy maps each origin to its provider.
  - Adds threats for key-file exposure, local receipt-log tampering or loss, a seller misreporting settlement, and a compromised client process.
- **v0.6 (PR 4b):**
  - Specifies the `vault-exact` x402 scheme (`docs/x402-vault-scheme.md`) and implements decision 8 in the facilitator spike (`packages/x402-vault`). Each limit has its own refusal reason and test.
  - Adds the seller and the facilitator to the trust boundaries, and the sponsor account to the assets.
  - Adds threats for x402 payload replay, a seller naming another provider, payee substitution, resource swap, facilitator misbehaviour, energy griefing, and a settlement that times out but finalizes later.
  - The resource URL is bound by the seller's per-request `invoiceId`, not hashed into the invoice (see resource swap).
- **v0.5 (PR 4a):**
  - Records decisions 7 (custom x402 vault scheme), 8 (sponsor fee-griefing limits) and 9 (self-verified badge check). This closes the badge and sponsored-fees open decisions.
  - Resolves the x402 open verification: vault payments do not fit the standard `exact` scheme.
  - Adds threats for card hosts, oversized or slow cards, operator fetches and sponsor fee griefing.
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

Decisions of 22 Nov 2026:

7. **x402 via a custom vault scheme.** Vault payments do not fit x402's standard Concordium `exact` scheme (see open verification). The seller flow uses a vault-specific scheme on the standard x402 v2 flow, so every paid request still goes through the vault's caps, allowlist and receipts. Specified in `docs/x402-vault-scheme.md` and implemented as a spike in `packages/x402-vault` (PR 4b).
8. **Sponsor fee-griefing limits.** Before co-signing, the facilitator:
   - dry-runs `guard_vault.pay` as the agent, and refuses if it would reject,
   - sponsors only `pay` calls on the configured vault,
   - caps expiry at 60 s,
   - allows one in-flight payment per sender.

   PR 4b implements these in `VaultExactFacilitator`, plus a cap on sponsored execution energy.
9. **Badge check is self-verified.** "Verified by Concordium" is checked by fetching the Agent Card from `agent_uri` and comparing its SHA-256 with the registry's `metadata_hash`, together with Active status. No hosted badge service is trusted. `packages/badge-check` does this before the owner approves a card hash with `add_provider`. The vault then re-checks Active status and the card hash on every `pay`.

## Trust boundaries

- **Owner:** identity-backed account that creates and funds the vault. It alone may change caps, the agent, the allowlist and the pause, and withdraw funds to its own account.
- **Agent:** a key that may only call `pay`. It cannot change rules, even if compromised. It is always a different account from the owner.
- **Providers:** CIS-8004 Agent Registry agents that the owner allowlisted with an approved card hash. The vault re-checks each one against the registry on every payment.
- **Agent Registry:** the CIS-8004 contract named at init. The vault trusts its replies about status, card hash and wallet. Its address cannot change for the vault's lifetime.
- **Chain:** `GuardVault` and its events are the source of truth. Off-chain logs are not.
- **Operator box:** the machine that holds the throwaway testnet keys, as mode-600 wallet-export files named by environment variables. The agent client refuses a key file that group or others can access, or that is not a testnet export. It runs every deploy and live testnet step, and confirms the official registry address. Development and CI environments hold no keys.
- **CI and dependencies:** GitHub Actions runners, crates.io, npm, and pinned tool binaries from GitHub releases. CI runs with read-only repository permissions and no secrets, and it never deploys.
- **Seller (x402 resource server):** an allowlisted registry agent that answers `402` with `vault-exact` requirements. It is untrusted by the agent: whatever it asks for, the vault pays only allowlisted providers within the caps.
- **Facilitator (x402):** verifies and settles payments for sellers, and holds the sponsor key, which pays transaction fees only. It cannot change what the agent signed. It can refuse, delay or misreport (see threats).
- **Verifier and node:** the verifier rebuilds the receipt chain from a Concordium node's finalized data, so it trusts that node to report the chain honestly. Anyone can point it at a node they run. CCDExplorer is a convenience view, not the source of truth. The node adapter connects only over TLS. It refuses a node whose genesis block isn't Concordium testnet's before asking it anything else.

## Assets

- Test CCD held in `GuardVault`.
- The right to change spending rules and the allowlist.
- Public receipt integrity (hash-linked chain events).
- Agent and owner keys (throwaway testnet keys only).
- The facilitator's sponsor account and its test CCD for fees.
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
| Replay | A valid `pay` is submitted twice, or an old invoice is reused. | `pay` must use the next `nonce` in sequence and an `invoice_hash` never paid before. Both are checked on chain. In the client, replay-guard refuses to sign a reused invoice or a stale nonce. It is a second layer, not the source of truth. |
| Provider spoofing | Payment is sent to an unapproved or impersonated provider. | Only allowlisted registry agents can be paid. Before approving one, the owner runs `claw-pay-badge-check`, which fetches the card and checks its hash against the registry (decision 9). On every payment, the registry must report the agent Active with the approved card hash, and the money goes to its registered wallet. |
| Receipt forgery | A fake receipt is presented off chain. | Receipts are contract events. Each hash covers the previous one, and the head is in contract state. `claw-pay-verify` rebuilds the chain from the vault's events alone: it recomputes every hash, follows the links, replays the owner's rules against every payment, and requires the chain to end at the contract's head. A forged chain that is consistent with itself still fails the rule replay or the head check. |
| Receipt splicing | Receipts from another vault are mixed into this vault's chain. | The vault's own address is part of every hashed body, so foreign receipts fail the hash or link check. |
| Cap-window boundary | The window is a fixed UTC day (decision 1). A compromised agent spends the full daily cap just before 00:00 UTC and again just after, which is 2× the daily cap within a millisecond. | Accepted and documented. The worst case is bounded at 2× the daily cap across midnight. The test `inv4_midnight_edge_allows_two_caps_within_a_millisecond` shows the edge. Owners should size the daily cap with that in mind. |
| Amount arithmetic | A running total or cap check overflows and wraps, letting a payment through. | Checked arithmetic on amounts, totals and the nonce. An overflow rejects the call. Unit-tested at `Amount::MAX`. |
| Callbacks | A payment target or the registry runs code that calls back into the vault mid-payment. | The registry is queried read-only, before any state change. `pay` updates state before transferring. Transfers go only to account addresses, which run no code. A callback would arrive with the vault as sender and fail every role check. |
| Wrong registry address | The owner initializes the vault with a fake or wrong "registry", which approves any agent. | The registry address is an init parameter. The owner must use the official CIS-8004 testnet instance, confirmed on the operator box: the address could not be confirmed from the build environment. `claw-pay-owner init` has no default: `--registry` must be given, and it is printed in the plan before `--send`. `Initialized` logs the address, and `view` shows it, so anyone can check it. A wrong address means redeploying, because the vault is immutable. |
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
| Secret leakage | A key, seed phrase or wallet export is committed or printed in logs. | gitleaks runs on every push and pull request over the full history. `.gitignore` covers key files and wallet exports. On the operator box, the agent and owner keys are mode-600 wallet-export files named by environment variables (`CLAW_PAY_AGENT_KEY_FILE`, `CLAW_PAY_OWNER_KEY_FILE`). The key itself is never in the environment. The client's errors never echo the file's contents. CI and development environments hold no keys, and tests generate throwaway keys in memory only. |
| Wrong network | The client is pointed at mainnet by mistake. | The client refuses any network other than `testnet`: `assertTestnet` runs first in `loadConfig`, before any file is read. The key file must also be a `testnet` wallet export. The x402 facilitator serves one configured network and refuses requirements for any other (`unsupported_network`). The node adapter refuses any node whose genesis block isn't testnet's (`connectTestnetNode`). Throwaway keys must never be funded on mainnet. |
| Unfinalized receipts | The verifier counts a receipt from a block that is later dropped. | `claw-pay-export` never reads above the last finalized height. It reads `view` at the same last block, so the events and the head are one snapshot. The verifier checks whatever events file it is given, so the file must come from a node the reader trusts. |
| Node lies or omits events | The node used for the export hides receipts, or reports a false view. | If events are omitted, the verifier's head check fails, but only while the view is honest. A node that fakes both can't be caught from its own data. Use a node you trust or run, re-export from a second node, or cross-check the head and receipts on CCDExplorer. |
| Incomplete export range | The export starts after the vault's init, or stops early. | The verifier refuses it: the receipt chain no longer starts at zero, or no longer ends at the view's head. |
| Module provenance | The module deployed on testnet is not the one built from the reviewed commit. | `claw-pay-owner deploy` computes the module reference from the file before sending. It reports success only if the chain's `ModuleDeployed` reference matches. Publish that reference with the source commit. PR 6 considers a `cargo-concordium` verifiable build on the operator box. |
| Hostile or changed card host | The host at `agent_uri` serves a card that differs from the one the owner reviewed, or changes it later. | The badge check accepts a card only if its SHA-256 equals the on-chain `metadata_hash`, so a swapped card fails. If the provider later changes its card and registry hash, the vault refuses payments (`CardHashMismatch`) until the owner re-checks and re-approves. |
| Oversized or slow card | A card host answers with a huge body or never finishes. | `fetchCard` stops at 64 KiB and after 10 s, and the check reports the card as unavailable. |
| Operator fetches an untrusted URL | `agent_uri` points somewhere the operator box should not fetch. | The badge check is run by hand, fetches HTTPS only, follows no redirects, and sends no credentials. Cards can also be downloaded separately and checked with `--card`. |
| Sponsor fee griefing (x402) | An agent, or someone holding its key, submits sponsored payments that fail on chain, so the facilitator pays fees for nothing. | Decision 8: dry-run first and refuse failures, sponsor only `pay` on the configured vaults, a 60 s expiry cap, and one in-flight payment per sender. Implemented in `packages/x402-vault` (PR 4b): each limit has its own `invalidReason` and test. A payment can still fail between the dry run and execution (a pause, or a race), which costs one fee. |
| x402 payload replay | A captured `vault-exact` payload is submitted again, to the same or another facilitator. | The vault accepts each `nonce` and `invoice_hash` once (INV-6), and the transaction expires within 60 s. The dry run refuses a replay before the sponsor signs. |
| Seller names another provider (x402) | A hostile server's `402` names a different allowlisted provider, so the agent pays someone other than the server it called. | The vault pays only providers the owner allowlisted, within the caps, and the receipt names the provider. The agent client's spend-policy maps each origin to its provider, and optionally its wallet. It refuses a mismatched offer (`provider_mismatch`, `payto_mismatch`) before anything is signed. The origin comes from the URL the agent requested, never from the seller's `resource.url`. |
| Payee substitution (x402) | The requirements name a `payTo` that is not the provider's wallet, or the payment lands somewhere else. | `provider`, `payTo` and `invoiceId` are inside the invoice hash. The facilitator requires the dry-run and final receipts to show `payTo` as payee. The vault pays only the registry `agent_wallet` (INV-11). |
| Resource swap (x402) | A payment made for one resource is used to get another. | x402 does not give the client scheme the resource, so the URL is not in the invoice hash. The seller issues a fresh `invoiceId` for each `402` answer, serves only the resource it was issued for, and the vault pays each invoice once. A seller that ignores this duty can be tricked; the spec lists it as a seller duty. |
| Facilitator misbehaviour (x402) | The facilitator alters, withholds or misreports a payment. | The agent's signature covers the vault, entrypoint, parameter and expiry, so the sponsor cannot change them. It can refuse or delay until expiry (at most 60 s). A seller can confirm the receipt itself with `claw-pay-verify`. |
| Energy griefing (x402) | An agent asks the sponsor to pay for a huge execution-energy allowance. | The facilitator refuses energy above its configured cap (`energy_too_high`). |
| Settlement timeout (x402) | `settle` times out, but the transaction finalizes later, so the agent paid and the seller did not serve. | The seller does not serve on a timeout. The transaction can finalize only until its expiry (at most 60 s). The receipt is public, so the seller can reconcile by invoice hash, and the invoice cannot be paid twice. Automatic reconciliation is not built yet. |
| Key file exposure | The agent's or owner's wallet export is readable by other users, or is a mainnet export. | `loadKeyFile` checks permissions before reading, for every key. It refuses group or other access, another owner and a non-testnet export. |
| Operator mistake | The operator sends a change to the wrong vault, with the wrong amount, or with wrong parameters. | `claw-pay-owner` prints the full plan (contract, entrypoint, decoded parameter, amount). It dry-runs every update as the owner, and sends only with `--send`. A dry run the vault rejects can't be sent, and its reject code and name are shown. There are no defaults for the registry or the agent. On-chain checks still apply: caps must satisfy `0 < per-tx ≤ daily`, and the agent can never be the owner. |
| Local receipt log tampering or loss | Someone edits, reorders or deletes the agent's local log to hide spending or replay an invoice. | Each line is hash-linked to the one before and re-verified on open. An edited, reordered or mid-truncated log is refused. The file is created mode 600, and a log writable by group or others is refused. Dropping lines from the end can't be seen locally. The log is a second layer only: the vault's on-chain receipts are the truth. `claw-pay-export --log` reconciles the log against them. |
| Seller misreports settlement (x402) | The seller says a payment failed although it landed, so the client's daily total runs low. | The client counts every signed payment as spent unless the reported failure means nothing moved. Timeouts and unknown outcomes count. The vault's own caps hold whatever the client believes. The client also takes the vault's own `spent_today` (from `view`) as a floor under its local total. `claw-pay-export --log` reports any payment that landed despite a reported failure. |
| Compromised client process | Malware or a bug in the agent process tries to make the key sign something else. | The capped signer holds the key and signs only a sponsored `guard_vault.pay` from the agent, on its own vault, within the per-payment and energy caps and a 60 s expiry. The vault's caps and allowlist bound anything that is signed. Code running as the operator's user can still read the key file: see residual risk. |

## Open decisions

None at the moment. The badge and sponsored-fees questions were settled on 22 Nov (decisions 8 and 9).

## Open verification

- **x402 `exact` (resolved, 22 Nov).** Vault payments do not fit x402's standard Concordium `exact` scheme.
  - The spec (`specs/schemes/exact/scheme_exact_concordium.md` in `x402-foundation/x402`) and the official `@x402/concordium` facilitator accept only a `SimpleTransfer` or transfer-with-memo, or a PLT `TokenUpdate`, from the payer's own account. They also require exactly one transfer operation.
  - A vault payment is a contract update calling `guard_vault.pay`.
  - Decision 7 follows from this.
- **Badge definition.** The definition used in decision 9 comes from Concordium's badge documentation as quoted in a third-party package's source; the docs site was not reachable from the build environment. Confirm it against `docs.concordium.com` on the operator box.
- **x402 on a live node.** The `vault-exact` facilitator is tested only against an in-memory chain. Submitting sponsored V1 transactions, dry-running `pay` through `invokeInstance`, and reading finalized events must be confirmed on testnet from the operator box. The adapter for this is in `packages/node-adapter` (PR 5b), and the live run is part of PR 5c.
- **Testnet genesis hash.** The node guard expects testnet's genesis block hash to start with `4221332d34e1694168c2a0c0b3fd0f27`, the reference in the CAIP-2 id from the x402 Concordium spec. Confirm it against a testnet node on the operator box. If it is wrong, the guard fails closed and refuses to connect.
- **Registry address.** The official CIS-8004 registry address on testnet must be confirmed on the operator box before deploy.

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

Code running as the operator's user can read the agent key file. The capped signer then no longer applies, but the vault's caps, allowlist and pause still bound the loss, as for an agent-key compromise.

A compromised sponsor key can spend the sponsor account's test CCD on fees, but cannot move vault funds or sign as the agent.

Within the caps, a compromised agent key can still pay allowlisted providers until the owner pauses. That is up to 2× the daily cap across midnight, and transactions already submitted may finalize after the pause. Pinning and lockfiles reduce supply-chain risk but do not remove it.
