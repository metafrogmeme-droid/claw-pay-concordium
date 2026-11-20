# Claw Pay for Concordium

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Testnet only.** This project targets Concordium testnet. It does not use mainnet, real funds, or paid services.

## Prior work

Claw Pay for Concordium is a new build for the Concordium Trusted Agents hackathon. It reuses the decision rules (`decide` core) and receipt log from our earlier Claw Pay project; the Concordium contracts, Agent Registry checks, x402 flow and verifier are new.

## What it is

An entry for the Encode x Concordium Trusted Agents hackathon. An AI agent can pay on Concordium testnet only within limits it cannot override, only to verified providers, and every payment leaves a public receipt anyone can check.

Limits live in a Rust smart contract (`GuardVault`). The owner alone can change rules. The agent can only call `pay`. Payments go only to providers verified in Concordium's Agent Registry, and each payment emits a hash-linked receipt on chain.

## Status

Early. PR 1 adds the repo layout, CI and threat model v0.1. The vault, client, demo and verifier land in later small draft pull requests. Nothing here is production-ready, and nothing should be pointed at mainnet.

## Layout

| Path | What it holds |
|---|---|
| `contracts/guard-vault/` | `GuardVault` Rust contract (`concordium-std`, target `wasm32v1-none`) and its simulated-chain tests |
| `packages/agent-client/` | TypeScript agent client; for now only the testnet-only network guard |
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
cargo test --workspace --locked
```

TypeScript needs Node 22 (see `.nvmrc`):

```bash
npm ci --ignore-scripts
```

```bash
npm run lint && npm run typecheck && npm test
```

## License

MIT © HUMANOID-TRADERS
