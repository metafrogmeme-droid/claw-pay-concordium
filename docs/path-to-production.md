# Path to production

Claw Pay for Concordium is a **testnet-only** hackathon entry. This page lists what would have to change before anything like it could hold real funds. It is a checklist for later, not a promise or a plan for this entry. Mainnet, real funds and KYC stay out of the hackathon scope (see `SCOPE.md`).

Each item says why it matters and which part of the repository it touches.

## 1. Contract

| Item | Why | Touches |
|---|---|---|
| Independent security audit of `GuardVault` | The vault is the only hard limit on what an agent can spend. | `contracts/guard-vault/` |
| Verifiable build: `cargo-concordium` build in a pinned container, with the module reference published next to the source commit | Lets anyone confirm the deployed module is the reviewed code. `claw-pay-owner deploy` already checks the reference it computes against the chain's. | `contracts/guard-vault/`, `packages/owner-cli/` |
| Property-based and fuzz tests on the caps, the UTC-day window and the receipt chain | Today's tests are example-based, one or more per invariant. | `contracts/guard-vault/tests/` |
| Formal review of the `pay` path: the registry call, state update, transfer and event order | `pay` is the only path money leaves the vault on the agent's behalf. | `contracts/guard-vault/src/lib.rs` |
| A decision on upgrades | The vault is immutable by design: to migrate, the owner pauses, withdraws and redeploys (decision 2). Production could keep that, or add a reviewed, time-locked upgrade path. | Contract, `THREAT_MODEL.md` |
| A decision on the cap window | A fixed UTC day allows up to 2× the daily cap across midnight (decision 1). A rolling window would remove that edge. | Contract, verifier |

## 2. Keys

| Item | Why | Touches |
|---|---|---|
| Owner on a hardware wallet or a multi-signature account | A compromised owner key can withdraw everything: this is the residual risk in the threat model. | Operations, `packages/owner-cli/` |
| Agent key in an HSM or cloud KMS behind the capped signer | Today it is a mode-600 file. In production the key should never be readable by the agent process. | `packages/agent-client/` (the capped signer becomes a KMS call) |
| Regular agent-key rotation with `set_agent` | Limits how long a leaked key stays useful. | Operations |
| Sponsor as a low-balance, monitored hot wallet, topped up automatically | It pays fees only, but a stolen key can drain its balance. | `packages/demo/`, a hosted facilitator |
| No key material in files at all | Testnet uses throwaway key files. Production would use managed signers only. | `packages/agent-client/src/keys.ts` |

## 3. Registry and trust

| Item | Why | Touches |
|---|---|---|
| The official CIS-8004 registry address pinned per network, and checked at init | A wrong registry approves any agent. Today the operator confirms it by hand. | `packages/owner-cli/` (`init`) |
| Badge and card checks automated and repeated | Today the owner runs `claw-pay-badge-check` by hand before allowlisting. | `packages/badge-check/` |
| A revocation watch that alerts when an allowlisted provider is revoked or changes its card | The vault already refuses such payments; a watch tells the owner why payments start failing. | `packages/node-adapter/` |

## 4. x402

| Item | Why | Touches |
|---|---|---|
| Propose `vault-exact` upstream to the x402 project, or move to an official vault-style scheme if one appears | `vault-exact` is a custom scheme today, because vault payments don't fit `exact`. | `docs/x402-vault-scheme.md`, `packages/x402-vault/` |
| A hosted facilitator with rate limits, abuse controls and a fee budget per seller | The demo runs the facilitator inside the seller, on loopback. | `packages/x402-vault/`, `packages/demo/` |
| Stablecoin or PLT payments beside CCD | Sellers usually price in a stable unit. | Contract, x402 scheme, client |
| Automated reconciliation of settlements that timed out | A timed-out payment may still land. Today the seller doesn't serve, and the owner reconciles with `claw-pay-export --log`. | `packages/node-adapter/`, `packages/demo/` |
| A persistent, shared invoice store | The demo's invoice book is in memory, per process. | `packages/demo/` |

## 5. Operations

| Item | Why | Touches |
|---|---|---|
| A live receipt exporter with alerts: head mismatch, cap near its limit, failed or rejected payments, pause | Today export and verify are run by hand. | `packages/node-adapter/` |
| Automatic reconcile of every agent's local log against the chain | Catches misreported settlements as they happen, not afterwards. | `packages/node-adapter/` (`reconcile`) |
| Incident runbooks: pause, withdraw, rotate the agent, revoke a provider | The tools exist (`claw-pay-owner`); production needs tested procedures and on-call owners. | Operations, `docs/` |
| Node redundancy and cross-checks: read from two independent nodes and compare | The exporter and the page trust the node they use. | `packages/node-adapter/`, `packages/verifier-page/` |
| Publishing the verifier page on a stable, integrity-protected host | Today it is served locally. | `packages/verifier-page/` |

## 6. Compliance and product

| Item | Why | Touches |
|---|---|---|
| Owner identity through Concordium's ID layer, tied to the vault | Lets counterparties see that a real, identified party stands behind each vault. | Product |
| KYC and AML where the law requires them, for owners and sellers | Real-money payments carry legal duties that testnet doesn't. | Product, legal |
| Terms for sellers: refunds, disputes, what a receipt proves | A receipt proves payment, not delivery. | Product, legal |
| Privacy review of receipts | Receipts are public by design: amounts, payees and times are visible to anyone. | Product, `THREAT_MODEL.md` |

## 7. Close every open verification item

`THREAT_MODEL.md` lists what has only been checked offline so far:
- the official registry address,
- the testnet genesis prefix,
- the badge definition,
- x402 on a live node,
- gRPC-web CORS for the verifier page.

Each must be confirmed on a live network before going further. On mainnet, each needs its mainnet equivalent.
