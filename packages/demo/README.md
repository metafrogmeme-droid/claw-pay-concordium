# Testnet demo

This package holds the two command-line tools of the end-to-end demo:
- `claw-pay-seller`: an x402 seller that charges through the agent's vault, with an in-process `vault-exact` facilitator.
- `claw-pay-agent`: fetches a URL as the agent, and pays a 402 through the vault if every guard agrees.

The full operator walk-through is in [`docs/testnet-demo.md`](../../docs/testnet-demo.md).

**Operator box only, testnet only.** Both tools talk to a Concordium testnet node and sign with throwaway keys. The tests run offline, on an in-memory testnet.

## `claw-pay-seller`

```bash
node packages/demo/src/seller-cli.ts
```

| Variable | Meaning |
|---|---|
| `CLAW_PAY_NETWORK` | Must be exactly `testnet`. Checked first. |
| `CLAW_PAY_NODE` | `host:port` of a testnet gRPC endpoint. |
| `CLAW_PAY_SELLER_CONFIG` | The seller config (JSON; example in the runbook). |
| `CLAW_PAY_SPONSOR_KEY_FILE` | The sponsor's testnet wallet export, mode 600. The sponsor pays the fees of the agent's payments. |

What the seller does:
- **Listens on loopback only** (`127.0.0.1`, `localhost` or `::1`). It is a demo, not a public service.
- **Paid routes** answer `402` with a standard x402 v2 `PAYMENT-REQUIRED` header carrying a `vault-exact` offer.
- **On `PAYMENT-SIGNATURE`**, it checks the invoice, settles through the facilitator, and serves the body with `PAYMENT-RESPONSE`.
- **`GET /health`** is free.

**The invoice book** carries the scheme's seller duties:
- one fresh invoice per 402,
- honoured once (marked used before settling),
- only on the path it was issued for,
- only with the offer unchanged,
- only for 5 minutes.

It holds at most 1000 invoices. Refusals: `unknown_invoice`, `invoice_used`, `wrong_resource`, `offer_changed`, `invoice_expired`.

**The facilitator** is `VaultExactFacilitator` over the node adapter. It sponsors only `pay` on the configured vaults, within the energy cap, after a successful dry run.

## `claw-pay-agent <url>`

```bash
node packages/demo/src/agent-cli.ts http://127.0.0.1:8402/weather
```

It uses the agent client's configuration: `CLAW_PAY_NETWORK`, `CLAW_PAY_POLICY_FILE`, `CLAW_PAY_RECEIPT_LOG` and `CLAW_PAY_AGENT_KEY_FILE` (see `packages/agent-client/README.md`), plus `CLAW_PAY_NODE`.

It prints, in order:
- the HTTP status,
- the new receipt-log entries (`attempt`, then `settled` with the transaction hash, or `failed` with the reason),
- the body (first 2 KB).

A refusal names the layer and its reasons, for example `payment refused by spend-policy: over_per_payment`.

Exit codes:
- `0`: a 2xx response.
- `1`: the payment was refused or failed, or the response isn't 2xx.
- `2`: a usage, config, key or node problem.

## Tests

```bash
npm test --workspace @claw-pay-concordium/demo
```

All offline, listening on 127.0.0.1 only:
- the invoice book's rules, expiry and bound,
- the seller config parser,
- the seller handler, against a stub facilitator.

There is also an **end-to-end rehearsal**. The real `claw-pay-agent` pays the real `claw-pay-seller`, whose real facilitator settles through the node adapter, all on one in-memory testnet. It checks three cases:
- a payment settles and is logged,
- an offer over the cap is refused before the seller sees a payment,
- a paused vault fails the dry run, and nothing is submitted.
