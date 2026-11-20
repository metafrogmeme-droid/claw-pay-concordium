# Threat model v0

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Product:** Claw Pay for Concordium
**Version:** 0 (bootstrap)
**Date:** 20 Nov 2026 (Europe/Amsterdam)
**Network:** Concordium testnet only. No mainnet, no real funds.

This is a starting model for the draft PRs. It will be revised as the vault, allowlist, receipts and x402 flow land.

## Trust boundaries

- **Owner:** identity-backed account that funds the vault and alone may change caps, the allowlist and the pause.
- **Agent:** a key that may only call `pay`. It cannot change rules, even if compromised.
- **Providers:** payment destinations. Only Active Agent Registry agents whose card hash matches the allowlist are valid.
- **Chain:** `GuardVault` and its `Receipt` events are the source of truth. Off-chain logs are not.

## Assets

- Test CCD held in `GuardVault`.
- The right to change spending rules.
- Public receipt integrity (hash-linked chain events).
- Agent and owner keys (throwaway testnet keys only).

## Threats and mitigations

| Threat | What it looks like | Mitigation |
|---|---|---|
| Agent key compromise | An attacker uses the agent key to drain funds or change policy. | Loss is capped at one day's limit. The agent key cannot change rules, the allowlist or the pause. Only `pay` is allowed. |
| Limit bypass | A payment exceeds the per-tx or per-day cap, or ignores a pause. | Caps, allowlist and pause are enforced in the contract, not in the agent. |
| Replay | A valid `pay` is submitted twice, or an old invoice is reused. | `nonce` and `invoice_hash` are checked on chain. Spend-policy, replay-guard and capped-signer logic in the client are a second layer, not the source of truth. |
| Provider spoofing | Payment is sent to an unapproved or impersonated provider. | Allowlist of Active Agent Registry agents whose card hash matches. Badge check in PR 4. |
| Receipt forgery | A fake receipt is presented off chain. | Receipts are contract events. The verifier rebuilds the chain from chain events alone. |

## Open verification

- Whether vault payments fit the standard x402 `exact` scheme is unverified until the PR 4 seller spike.

## Out of scope for this entry

Mainnet, real funds, KYC, paid services, EVM and PayPal. Admin, keeper or off-chain operator compromise beyond the owner's documented powers is also out of scope for v0.

## Residual risk

A compromised owner key can change caps, the allowlist and the pause. Daily caps bound loss from an agent-key compromise, but they do not bound owner-key compromise. Testnet keys must stay throwaway, uncommitted, and mode 600 on the operator box.
