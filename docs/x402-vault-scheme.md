# Scheme: `vault-exact` on Concordium

**Status:** draft, Concordium testnet only. Implemented as a spike in `packages/x402-vault` (PR 4b). It is tested offline against an in-memory chain. The live node adapter and an HTTP seller demo come in PR 5.

## Summary

`vault-exact` is an x402 v2 payment scheme for an exact CCD amount paid **through a `GuardVault`**, not from the agent's own account. Every paid request therefore goes through the vault's per-tx and daily caps, its provider allowlist and its registry check. Each one leaves a hash-linked `Receipt` on chain.

The agent signs a sponsored `UpdateContract` transaction that calls `guard_vault.pay`. A facilitator checks it, co-signs as sponsor (so it pays the transaction fee), submits it and confirms the vault's receipt.

The scheme is **not interoperable** with `exact` facilitators, by design. It has its own scheme name, so an `exact` facilitator never sees a `vault-exact` payload.

## Why not `exact`

x402's Concordium `exact` scheme (`specs/schemes/exact/scheme_exact_concordium.md` in `x402-foundation/x402`) accepts only these, sent from the payer's own account:
- a `SimpleTransfer`,
- a transfer with memo,
- a PLT `TokenUpdate`.

It also requires exactly one transfer operation. A vault payment is a contract update, and the CCD leaves the vault, not the sender. This is decision 7 in `THREAT_MODEL.md`.

## Roles

| Role | Who | Holds |
|---|---|---|
| Agent (x402 client) | The vault's agent key | The agent key. It can only call `pay`. |
| Seller (resource server) | A CIS-8004 registry agent on the vault's allowlist | Nothing on chain for this flow. It is paid at its registry `agent_wallet`. |
| Facilitator | Verifies and settles for the seller | The sponsor key. It pays transaction fees only. |
| Vault | The agent owner's `GuardVault` instance | The test CCD, the rules and the receipt chain. |

## Flow

1. The agent requests a resource. The seller answers `402 Payment Required` with `vault-exact` requirements and a fresh `invoiceId`.
2. The agent reads its vault's `next_nonce` and its own account sequence number. It builds the `pay` transaction, signs it as sender and returns it in the payment payload.
3. The seller sends the payload and requirements to the facilitator's `verify`, then to `settle`.
4. The facilitator checks every rule below and dry-runs `pay`. It co-signs as sponsor, submits, waits for finalization and checks the vault's `Receipt`.
5. On success the seller serves the resource. The receipt is public, and `claw-pay-verify` can check it.

## `PaymentRequirements`

| Field | Value |
|---|---|
| `scheme` | `"vault-exact"` |
| `network` | CAIP-2 Concordium network. Testnet is `ccd:4221332d34e1694168c2a0c0b3fd0f27`. |
| `asset` | `"CCD"` |
| `amount` | micro-CCD as a decimal string, greater than 0 and at most u64. |
| `payTo` | The seller's registry `agent_wallet`, Base58. The vault pays this wallet (decision 6). |
| `maxTimeoutSeconds` | 1 to 60. The transaction expiry may be at most this far ahead. |
| `extra.feePayer` | The facilitator's sponsor account, Base58. The facilitator advertises it via `getExtra`. |
| `extra.provider` | The seller's registry token id, as a decimal string. |
| `extra.invoiceId` | 16 random bytes as 32 lowercase hex digits, fresh for each 402 answer. |

Example:

```json
{
  "scheme": "vault-exact",
  "network": "ccd:4221332d34e1694168c2a0c0b3fd0f27",
  "asset": "CCD",
  "amount": "1000000",
  "payTo": "<seller agent_wallet, Base58>",
  "maxTimeoutSeconds": 60,
  "extra": {
    "feePayer": "<facilitator sponsor account, Base58>",
    "provider": "10",
    "invoiceId": "<32 lowercase hex digits>"
  }
}
```

## Invoice hash

The agent puts this hash in `PayParams.invoice_hash`:

```
invoice_hash = SHA-256( F("claw-pay-concordium/x402-vault-exact/v1")
                      ‖ F(network) ‖ F(amount) ‖ F("CCD") ‖ F(payTo)
                      ‖ F(provider) ‖ F(invoiceId) )

F(s) = u32 little-endian byte length of UTF-8 s ‖ UTF-8 s
```

- `amount` and `provider` are decimal strings with no leading zeros.
- `invoiceId` is the lowercase hex string.
- The length prefixes stop bytes from moving between fields.
- The vault refuses an `invoice_hash` it has already paid (INV-6). So each 402 answer can be paid at most once.

**The resource URL is not in the hash.** x402 does not pass the resource to the client scheme's `createPaymentPayload`. A facilitator also cannot know which resource the seller is serving. So the binding to the resource is the seller's `invoiceId`: the seller issues it for one resource and honours it only for that resource (see seller duties).

## `PaymentPayload`

```json
{
  "x402Version": 2,
  "accepted": { "...": "the requirements above" },
  "payload": { "signedTransaction": { "...": "web-sdk Transaction.toJSON of the signed transaction" } }
}
```

`signedTransaction` is a **V1 (sponsored)** account transaction in `@concordium/web-sdk` 12 JSON form. Bigints are written as numbers when they are safe integers, otherwise as decimal strings. The transaction is:
- an `UpdateContract` on the agent's vault, entrypoint `guard_vault.pay`, attached amount 0,
- with parameter `PayParams { provider: u64, amount: u64, nonce: u64, invoice_hash: [u8; 32] }`, little-endian, exactly 56 bytes, where `nonce` is the vault's `next_nonce`,
- with header sender = the agent, sponsor = `extra.feePayer`, and expiry at most `maxTimeoutSeconds` ahead,
- with the sender signature filled in and the sponsor signature empty.

`fixtures/pay-params.v1.json` holds `PayParams` bytes produced by the contract's own serializer. The TypeScript encoder is tested against it.

## Facilitator verification

The facilitator MUST refuse unless every check passes. Each failure has a stable `invalidReason`.

| # | Check | `invalidReason` |
|---|---|---|
| 0 | The requirements are a valid `vault-exact` offer. | `invalid_requirements` |
| 0 | `network` is the facilitator's network. | `unsupported_network` |
| 0 | `extra.feePayer` is the facilitator's sponsor. | `sponsor_mismatch` |
| 1 | `signedTransaction` parses. | `invalid_transaction_format` |
| 1 | It is a V1 (sponsored) transaction. | `invalid_transaction_version` |
| 2 | The payload is an `UpdateContract`. | `not_a_contract_update` |
| 2 | Attached amount is 0. | `nonzero_amount` |
| 2 | The contract is on the facilitator's configured vault list. | `vault_not_allowed` |
| 2 | The entrypoint is `guard_vault.pay`. | `wrong_entrypoint` |
| 2 | Execution energy is at most the facilitator's cap. | `energy_too_high` |
| 3 | The parameter is exactly a 56-byte `PayParams`. | `invalid_pay_params` |
| 4 | `provider` equals `extra.provider`. | `provider_mismatch` |
| 4 | `amount` equals `amount`. | `amount_mismatch` |
| 4 | `invoice_hash` equals the hash above. | `invoice_mismatch` |
| 5 | The header sponsor is the facilitator's sponsor. | `sponsor_mismatch` |
| 5 | The sender is not the sponsor. | `sender_is_sponsor` |
| 6 | Expiry is after now. | `expired` |
| 6 | Expiry is at most now + min(`maxTimeoutSeconds`, facilitator cap ≤ 60 s). | `expiry_too_far` |
| 7 | The sender signature verifies against the sender's on-chain credentials. | `invalid_sender_signature` |
| 8 | The sender is the vault's agent, per the vault's `view`. | `sender_not_agent` |
| 9 | A dry run of `pay`, invoked as the sender with the same parameter and energy, succeeds. The vault's reject code is passed through in `invalidMessage` (e.g. `-11` `ExceedsDailyCap`). | `dry_run_rejected` |
| 9 | The dry run logs exactly one `Receipt`, with this provider, amount and invoice hash, and its payee equals `payTo`. | `dry_run_receipt_mismatch` |
| 10 | No other payment from this sender is being settled by this facilitator. | `payment_in_flight` |

Checks 2, 6, 9 and 10, plus the energy cap, are decision 8 (sponsor fee-griefing limits).

## Settlement

`settle` MUST:
1. Run every verification check again.
2. Take the in-flight lock for the sender.
3. Add the sponsor signature (`Transaction.sponsor`), submit, and wait for finalization.
4. Require that the transaction succeeded **and** logged a `Receipt` that matches, using the same receipt check as the dry run.
5. Release the lock, whatever the outcome.

| Outcome | Response |
|---|---|
| Success | `success: true`, `transaction` (hash), `network`, `payer` (agent, Base58), `amount` |
| A verification check fails | `success: false`, `errorReason` = that check's `invalidReason`. Nothing is submitted. |
| Not finalized in time | `errorReason: "finalization_timeout"` |
| Finalized but rejected | `errorReason: "transaction_rejected"`, with the vault's message |
| Finalized with no matching receipt | `errorReason: "receipt_mismatch"` |

**After a timeout** the transaction may still finalize, up to its expiry, which is at most 60 s after signing. The seller must not serve on a timeout. It can reconcile later by looking for a receipt with that invoice hash. The invoice hash cannot be paid twice, so a retry with the same `invoiceId` either finds the earlier payment or fails on chain.

## Seller duties

The seller (resource server) MUST:
- issue a fresh `invoiceId` for each 402 answer and remember, or authenticate, which resource it was issued for,
- accept a payment only if `accepted` equals the requirements it issued for that request, and serve only the resource that `invoiceId` was issued for,
- set `payTo` to its own registry `agent_wallet` and `extra.provider` to its own registry token id,
- serve only after `settle` returns `success: true`.

## Security considerations

- **Replay.** The vault accepts each `nonce` and each `invoice_hash` once (INV-6), and the transaction expires within 60 s. A replayed payload fails on chain, and the dry run catches it first.
- **Payee substitution.** `provider`, `payTo` and `invoiceId` are inside the invoice hash, and the receipt must show `payTo` as payee. The vault pays only the registry wallet of an allowlisted, Active provider (INV-7, INV-11).
- **Seller names another provider.** A hostile server can name any provider. The vault still pays only providers the owner allowlisted, within the caps. The agent client should also check that the provider matches the server it meant to pay (PR 5).
- **Facilitator misbehaviour.** The facilitator cannot change what the agent signed: the vault, the entrypoint, the parameter and the expiry are all covered by the sender signature. It can refuse, delay until expiry, or report falsely to the seller. The seller can confirm the receipt itself with `claw-pay-verify`.
- **Fee griefing.** Decision 8 limits what the sponsor pays for: configured vaults only, `pay` only, an energy cap, a 60 s expiry, a dry run, and one in-flight payment per sender. A transaction can still fail between the dry run and execution, for example after a pause or a race with another payment from the same vault. That costs one fee.
- **Wrong network.** A facilitator serves one configured network, and requirements must name a `ccd:` network. This project uses testnet only.

## Not in the spike

- The live `VaultChain` adapter on `ConcordiumGRPCNodeClient`: account info, the vault's `view`, the `invokeInstance` dry run, submission and finalization (PR 5).
- An HTTP seller and a hosted facilitator (PR 5 demo, operator box only).
- Reconciliation of timed-out settlements.
