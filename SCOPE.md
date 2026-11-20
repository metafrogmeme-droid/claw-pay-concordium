# Claw Pay for Concordium: scope

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO. Encode x Concordium Trusted Agents Hackathon.

- **Entry name:** Claw Pay for Concordium
- **Repo:** `metafrogmeme-droid/claw-pay-concordium`
- **Checkpoint 1:** 22 Nov 23:59 UTC (23 Nov 00:59 CET)
- **Deadline:** 9 Dec 23:59 UTC (10 Dec 00:59 CET)

## Goal

An AI agent pays on Concordium testnet only within limits it can't override, only to verified providers, and every payment leaves a public receipt.

## In / out

- **In:** Rust vault contract, agent client, demo x402 seller, verifier, threat model, video (up to 3 min), CCDExplorer link, path to production.
- **Out:** mainnet, real funds, KYC, paid services, EVM, PayPal.

## Architecture

- **GuardVault (Rust):** holds test CCD and enforces per-tx and per-day caps, an allowlist and a pause. Only the owner changes rules. The agent can only call `pay`.
- **`pay(provider, amount, nonce, invoice_hash)`:** checks, transfers, and logs a hash-linked `Receipt` event.
- **Allowlist:** only Active Agent Registry agents whose card hash matches.
- **Agent client (TS):** reuses the `decide` core and receipt log from our earlier Claw Pay project, plus spend-policy, replay-guard and capped-signer logic.
- **Verifier CLI and page:** rebuild the receipt chain from chain events alone.

## Concordium features

- **Smart contracts:** the limits live on chain, not in the agent.
- **Agent Registry and badge:** a person stands behind each party.
- **ID layer:** the owner's account is identity-backed.
- **x402 with sponsored fees:** for the seller flow. *Unverified:* whether payments made through the vault fit the standard `exact` scheme. PR 4 tests it.
- **CCDExplorer:** the evidence link.

## PRs (draft, tests, green CI)

1. Repo, CI, gitleaks, threat model v0
2. Vault: caps, owner-only rules, pause, nonce
3. Allowlist, receipts, verifier CLI
4. Badge check, x402 seller spike
5. Agent client, end-to-end testnet demo
6. Verifier page, docs, path to production

## Threat model

- **Agent key compromise:** loss is capped at one day's limit, and the key can't change rules.
- **Limit bypass:** the contract enforces the caps.
- **Replay:** the nonce and invoice hash stop it.
- **Provider spoofing:** the allowlist and badge check stop it.
- **Receipt forgery:** receipts are chain events, not our logs.

## Timeline (CET)

| Date | Step |
|---|---|
| 20 Nov | Scope yes |
| 22 Nov | Checkpoint 1 (due 23 Nov 00:59 CET) |
| 21 Nov–5 Dec | PRs 1–6 |
| 6 Dec | Freeze; Dev records the testnet demo |
| 7 Dec | Marketing cuts the video |
| **8 Dec** | **Submit** |
| 9 Dec | Buffer |

## Rules

- Testnet only: no mainnet, no real funds, no paid services.
- Testnet keys are throwaway, mode 600, never committed.
- Claude Code builds on Accept edits, plan first. Draft PRs only.
- Patrick approves the scope, every merge and the final submission. Sign-up, checkpoint and any KYC are his.

## Decisions (Patrick, 20 Nov 2026, Europe/Amsterdam)

- **Scope:** yes. Testnet only. Every PR is a draft. Patrick approves each merge and the submission.
- **Public repo:** yes. A new public repo, `claw-pay-concordium`, holding only what we publish for this entry. Existing private product repos stay private.
- **Video:** Marketing produces the required demo video from Dev's testnet demo recording. Patrick approves the final cut.
- **Grants:** apply after the hackathon.
