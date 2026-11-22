# Agent client

The agent side of Claw Pay for Concordium. `payFetch(url)` fetches a resource. On `402 Payment Required` it pays through the agent's `GuardVault` with x402 [`vault-exact`](../../docs/x402-vault-scheme.md), but only if every client-side guard agrees. Every outcome goes into a local, hash-linked receipt log.

**Testnet only.** The client refuses any other network before it reads anything.

**Status (PR 5a).** The guards and the pay flow are implemented and tested offline, against a local x402 seller on 127.0.0.1 and an in-memory chain. The live chain adapter (`AgentChain` on a Concordium node) comes in PR 5b and runs on the operator box.

## The layers a payment passes

| # | Layer | Refuses with |
|---|---|---|
| 1 | `assertTestnet`, first thing in `loadConfig` | a "testnet only" error |
| 2 | **spend-policy** `decide`, for the URL actually requested | `no_vault_exact_offer`, `unknown_origin`, `provider_mismatch`, `payto_mismatch`, `over_per_payment`, `over_daily`, `timeout_too_long`, `fee_payer_not_trusted` |
| 3 | **replay-guard** | `invoice_already_attempted`, `stale_nonce`, `payment_in_flight` |
| 4 | **capped-signer**, the only holder of the key | `not_sponsored_v1`, `wrong_sender`, `not_contract_update`, `wrong_vault`, `wrong_entrypoint`, `ccd_attached`, `malformed_params`, `over_per_payment`, `energy_too_high`, `expired`, `expiry_too_far` |
| 5 | The vault on chain: caps, allowlist, registry, nonce, invoice | the vault's reject codes |

Layers 2 to 4 throw `PaymentRefused` with `layer` and `reasons`, and nothing is signed or sent. They are a **second layer**. The vault enforces its own rules whatever the client does.

## Configuration

| Variable | Meaning |
|---|---|
| `CLAW_PAY_NETWORK` | Must be exactly `testnet`. |
| `CLAW_PAY_POLICY_FILE` | The spend policy (JSON, below). |
| `CLAW_PAY_RECEIPT_LOG` | The local receipt log (JSON lines). Created with mode 600. A log that group or others can write is refused. |
| `CLAW_PAY_AGENT_KEY_FILE` | The agent's **testnet** Concordium wallet export. Keep it outside the repository. |

The key file must be:
- a regular file owned by the user running the client,
- mode **600** (or 400), with no group or other access. This is checked before the file is read,
- a wallet export whose `environment` is `testnet`.

`loadConfig` puts the key straight into the capped signer and returns only that. Error messages never include the key file's contents.

### Policy file

Amounts are micro-CCD. Numbers that can exceed JavaScript's safe integer range are decimal strings.

```json
{
  "vault": { "index": "7", "subindex": "0" },
  "perPaymentMax": "1000000",
  "dailyMax": "3000000",
  "maxTimeoutSeconds": 60,
  "maxEnergy": "30000",
  "providers": [
    { "origin": "https://seller.example", "provider": "10", "payTo": "<seller agent_wallet, Base58>" }
  ],
  "feePayers": ["<trusted sponsor account, Base58>"]
}
```

- `providers` maps each origin the agent may pay to the registry token id it expects there, and optionally the wallet. Only the URL the agent requested counts, never the seller's own `resource.url`. Origins must be HTTPS. Plain HTTP is allowed only on loopback, for local demos.
- `dailyMax` uses the vault's window, the fixed UTC day. Set the client's caps at or below the vault's.
- `feePayers` is optional. When set, only these sponsors are accepted.

## Use

```ts
import { ReceiptLog, createPayingFetch, fileLogStore, loadConfig } from "@claw-pay-concordium/agent-client";

const config = loadConfig(process.env);
const payFetch = createPayingFetch({
  policy: config.policy,
  agent: config.agent,
  sign: config.sign, // the capped signer
  chain, // AgentChain: vaultNonce() and accountSequence(); the live one comes in PR 5b
  log: ReceiptLog.open(fileLogStore(config.receiptLogPath)),
});

const response = await payFetch("https://seller.example/weather");
```

## Receipt log

The log has one JSON object per line: `attempt` once the payment is signed (before it is sent), then `settled` (with the transaction hash) or `failed` (with the reason).
- Each line carries `seq`, `prevHash` and its own SHA-256 `hash`, and the whole chain is re-verified on open.
- An edited, reordered or mid-truncated log is refused. Lines dropped from the end can't be detected locally. The vault's on-chain receipts are the truth there, and the PR 5b reconcile step uses them.
- **Daily spend** counts a payment unless its reported failure means nothing moved. That means the facilitator refused it before submitting, or the vault rejected it on chain. Timeouts and unknown outcomes count, because they may have landed.

## Tests

```bash
npm test --workspace @claw-pay-concordium/agent-client
```

All offline.
- Signing tests use ed25519 keys generated in memory.
- The key loader is tested with an injected file system. A dummy file that is not a key, in a temp directory, checks the real permission handling.
- The end-to-end test runs a real x402 seller on 127.0.0.1 that settles through `VaultExactFacilitator` over an in-memory chain.
