# Claw Pay for Concordium

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Testnet only.** This project targets Concordium testnet. It does not use mainnet, real funds, or paid services.

## What it is

An entry for the Encode x Concordium Trusted Agents hackathon. An AI agent can pay on Concordium testnet only within limits it cannot override, only to verified providers, and every payment leaves a public receipt anyone can check.

## How it works

1. **The limits live in a Rust smart contract**, `GuardVault`.
   - It holds the test CCD and enforces per-payment and daily caps, a provider allowlist and a pause.
   - Only the owner can change the rules. The agent can only call `pay`.
2. **Providers are verified in Concordium's Agent Registry.**
   - The vault checks the registry on every payment, and pays only an Active agent with the approved card, at its registered wallet.
3. **The agent pays over x402** with a vault scheme, `vault-exact`.
   - Before anything is signed, three client-side checks must agree: spend-policy, replay-guard and a capped signer.
   - A facilitator dry-runs each payment and sponsors its fee.
4. **Every payment logs a hash-linked `Receipt`** on chain.
5. **Anyone can rebuild and check the receipt chain** from the vault's events alone, with `claw-pay-verify` or the verifier page.

More detail, with diagrams, is in [`docs/architecture.md`](docs/architecture.md).

## Status

**Feature-complete for the hackathon scope, and fully tested offline.**
- The contract, verifier, badge check, x402 scheme and facilitator, agent client, live node adapter, owner CLI, demo seller and agent, and the verifier page are in.
- The live testnet run follows [`docs/testnet-demo.md`](docs/testnet-demo.md) on the operator box.

Nothing here is production-ready, and nothing should be pointed at mainnet. [`docs/path-to-production.md`](docs/path-to-production.md) lists what would have to change first.

## Prior work

Claw Pay for Concordium is a new build for the Concordium Trusted Agents hackathon. It carries over the design of the decision rules (`decide` core) and the receipt log from our earlier Claw Pay project, re-implemented from scratch here as spend-policy and a hash-linked receipt log. The Concordium contracts, Agent Registry checks, x402 flow, verifier and verifier page are new.

## Documents

| Document | What it covers |
|---|---|
| [`SCOPE.md`](SCOPE.md) | Scope, goals and the plan of pull requests |
| [`THREAT_MODEL.md`](THREAT_MODEL.md) | Decisions, trust boundaries, invariants, threats, open verification and residual risk |
| [`docs/architecture.md`](docs/architecture.md) | How the pieces fit, one paid request step by step, where each rule is enforced, data formats |
| [`docs/x402-vault-scheme.md`](docs/x402-vault-scheme.md) | The `vault-exact` x402 scheme spec |
| [`docs/testnet-demo.md`](docs/testnet-demo.md) | The operator runbook for the end-to-end testnet demo |
| [`docs/path-to-production.md`](docs/path-to-production.md) | What would have to change before real funds |

## Layout

| Path | What it holds |
|---|---|
| `contracts/guard-vault/` | `GuardVault` Rust contract (`concordium-std`, target `wasm32v1-none`) and its simulated-chain tests |
| `contracts/mock-agent-registry/` | Test-only CIS-8004 Agent Registry mock used by the tests. Never deploy. |
| `packages/verifier/` | `claw-pay-verify`: rebuilds and checks the receipt chain from vault events |
| `packages/badge-check/` | `claw-pay-badge-check`: checks a registry agent is Verified by Concordium before it is allowlisted |
| `packages/x402-vault/` | x402 `vault-exact` scheme: agent client and facilitator for payments through `GuardVault` |
| `packages/agent-client/` | Agent client: `payFetch` pays x402 `vault-exact` offers through the vault behind spend-policy, replay-guard and a capped signer, with a local receipt log |
| `packages/node-adapter/` | Live testnet connection: node guard, vault view, gRPC `VaultChain`/`AgentChain`, `claw-pay-export` for finalized events, and log reconcile |
| `packages/owner-cli/` | `claw-pay-owner`: the vault owner's testnet CLI (deploy, init, deposit, caps, agent, pause, allowlist, withdraw, view), dry run unless `--send` |
| `packages/demo/` | Testnet demo: `claw-pay-seller` (x402 seller, invoice book, in-process facilitator) and `claw-pay-agent` |
| `packages/verifier-page/` | The verifier page: the receipt checks in a browser, on an events file or live from a testnet node (built page in `site/`) |
| `docs/` | Architecture, the `vault-exact` scheme spec, the testnet demo runbook and the path to production |
| `fixtures/` | Golden vault events, vault view, registry replies, `pay` and owner parameters and reject codes, produced by the contract tests and read by the TypeScript tests |

## Local checks

None of these need keys, funds or a Concordium node.

Rust uses the toolchain pinned in `rust-toolchain.toml` and needs `cargo-concordium` 5.0.0:

```bash
cargo fmt --all -- --check
```

```bash
cargo clippy --workspace --all-targets --locked -- -D warnings
```

```bash
(cd contracts/guard-vault && cargo concordium build --out concordium-out/module.wasm.v1)
```

```bash
(cd contracts/mock-agent-registry && cargo concordium build --out concordium-out/module.wasm.v1)
```

```bash
cargo test --workspace --locked
```

TypeScript needs Node 22 (see `.nvmrc`):

```bash
npm ci --ignore-scripts
```

```bash
npm run lint && npm run typecheck && npm test
```

Rebuild the verifier page after changing it. CI fails if the committed page is out of date:

```bash
npm run build:page
```

Verify the golden receipt chain with the CLI:

```bash
node packages/verifier/src/cli.ts fixtures/vault-events.v1.json
```

Check the example registry agent's badge against the example card:

```bash
node packages/badge-check/src/cli.ts fixtures/agent-views.v1.json --token 10 --card fixtures/agent-card.example.json
```

## Check receipts in the browser

```bash
npm run serve:page
```

Then open http://127.0.0.1:8080. You can load the sample, open an events file from `claw-pay-export`, or read a vault live from a testnet node. See [`packages/verifier-page/README.md`](packages/verifier-page/README.md).

## Run the testnet demo

The end-to-end demo runs on the operator box only, against Concordium testnet with throwaway keys. Follow [`docs/testnet-demo.md`](docs/testnet-demo.md).

## License

MIT © HUMANOID-TRADERS
