# Claw Pay for Concordium

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Testnet only.** This project targets Concordium testnet. It does not use mainnet, real funds, or paid services.

## Prior work

Claw Pay for Concordium is a new build for the Concordium Trusted Agents hackathon. It reuses the decision rules (`decide` core) and receipt log from our earlier Claw Pay project; the Concordium contracts, Agent Registry checks, x402 flow and verifier are new.

## What it is

An entry for the Encode x Concordium Trusted Agents hackathon. An AI agent can pay on Concordium testnet only within limits it cannot override, only to verified providers, and every payment leaves a public receipt anyone can check.

Limits live in a Rust smart contract (`GuardVault`). The owner alone can change rules. The agent can only call `pay`. Payments go only to providers verified in Concordium's Agent Registry, and each payment emits a hash-linked receipt on chain.

## Status

In progress. The vault contract enforces caps, owner-only rules, a pause, replay protection, a registry-checked provider allowlist and hash-linked receipts. A verifier CLI rebuilds and checks the receipt chain from the vault's events alone. A badge-check tool self-verifies a provider's Agent Card before the owner allowlists it. An x402 scheme, `vault-exact`, lets sellers charge an agent through its vault: the spec, agent client and facilitator are in, tested offline. The agent client pays only when its spend-policy, replay-guard and capped signer all agree, and it keeps a hash-linked local receipt log. The live node adapter, seller demo, testnet runbook and verifier page land in later small draft pull requests. Nothing here is production-ready, and nothing should be pointed at mainnet.

## Layout

| Path | What it holds |
|---|---|
| `contracts/guard-vault/` | `GuardVault` Rust contract (`concordium-std`, target `wasm32v1-none`) and its simulated-chain tests |
| `contracts/mock-agent-registry/` | Test-only CIS-8004 Agent Registry mock used by the tests. Never deploy. |
| `packages/agent-client/` | Agent client: `payFetch` pays x402 `vault-exact` offers through the vault behind spend-policy, replay-guard and a capped signer, with a local receipt log |
| `packages/verifier/` | `claw-pay-verify`: rebuilds and checks the receipt chain from vault events |
| `packages/badge-check/` | `claw-pay-badge-check`: checks a registry agent is Verified by Concordium before it is allowlisted |
| `packages/x402-vault/` | x402 `vault-exact` scheme: agent client and facilitator for payments through `GuardVault` |
| `docs/` | Specs, starting with the `vault-exact` x402 scheme |
| `fixtures/` | Golden vault events, registry replies and `pay` parameters, produced by the contract tests and read by the TypeScript tests |
| `SCOPE.md` | Scope, architecture and plan of pull requests |
| `THREAT_MODEL.md` | Trust boundaries, invariants, threats and open decisions |

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

Verify the golden receipt chain with the CLI:

```bash
node packages/verifier/src/cli.ts fixtures/vault-events.v1.json
```

Check the example registry agent's badge against the example card:

```bash
node packages/badge-check/src/cli.ts fixtures/agent-views.v1.json --token 10 --card fixtures/agent-card.example.json
```

## License

MIT © HUMANOID-TRADERS
