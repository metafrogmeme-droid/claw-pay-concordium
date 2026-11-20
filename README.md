# Claw Pay for Concordium

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

**Testnet only.** This project targets Concordium testnet. It does not use mainnet, real funds, or paid services.

## Prior work

Claw Pay for Concordium is a new build for the Concordium Trusted Agents hackathon. It reuses the decision rules (`decide` core) and receipt log from our earlier Claw Pay project; the Concordium contracts, Agent Registry checks, x402 flow and verifier are new.

## What it is

An entry for the Encode x Concordium Trusted Agents hackathon. An AI agent can pay on Concordium testnet only within limits it cannot override, only to verified providers, and every payment leaves a public receipt anyone can check.

Limits live in a Rust smart contract (`GuardVault`). The owner alone can change rules. The agent can only call `pay`. Payments go only to providers verified in Concordium's Agent Registry, and each payment emits a hash-linked receipt on chain.

## Status

Bootstrap only. Contracts, client, demo and verifier will land in small draft pull requests. Nothing here is production-ready, and nothing should be pointed at mainnet.

## License

MIT © HUMANOID-TRADERS
