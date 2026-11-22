# Owner CLI

`claw-pay-owner` is the vault owner's tool for Concordium **testnet**. It covers every owner step:
- deploy the module and create the vault,
- deposit and withdraw,
- set caps, change the agent, pause or unpause,
- add and remove providers,
- read the vault's state.

**Operator box only.** It signs with the owner's key and talks to a node, so it runs only where the operator runs testnet steps. The tests use an in-memory fake node and an in-memory key.

## Dry run unless `--send`

Every command that changes something is a **dry run** by default:
1. It prints exactly what would be sent: the contract, the entrypoint, the decoded parameter and the attached amount.
2. It runs the update against the node as the owner, without committing anything, and shows either the energy used or the vault's **reject code and name**, for example `-2 NotOwner` or `-5 InvalidCaps`.
3. Nothing is submitted. Add **`--send`** to submit.

With `--send`, a command whose dry run was rejected is **refused**. There is no override. The energy sent is the dry run's figure plus 20%, unless `--energy` is given.

`init` can't be dry-run, because the instance doesn't exist yet. It prints the plan and needs `--send` to go ahead.

## Configuration

| Variable | Meaning |
|---|---|
| `CLAW_PAY_NETWORK` | Must be exactly `testnet`. Checked before anything else. |
| `CLAW_PAY_NODE` | `host:port` of a Concordium testnet gRPC endpoint. The node's genesis block must be testnet's (see the node adapter). |
| `CLAW_PAY_OWNER_KEY_FILE` | The owner's **testnet** wallet export: a regular file owned by you, with mode 600, outside the repository. Read-only commands don't load it. |

The key-file rules are the same as for the agent key (`loadKeyFile` in the agent client). Error messages never show the file's contents.

## Commands

Amounts are micro-CCD (1 CCD = 1 000 000). A vault is written `<index>` or `<index>,<subindex>`.

```bash
node packages/owner-cli/src/cli.ts deploy --module contracts/guard-vault/concordium-out/module.wasm.v1
```

```bash
node packages/owner-cli/src/cli.ts init --module-ref <hex> --agent <agent account> --per-tx-cap 1000000 --daily-cap 5000000 --registry <index,subindex>
```

```bash
node packages/owner-cli/src/cli.ts deposit --vault <v> --amount 10000000
```

```bash
node packages/owner-cli/src/cli.ts add-provider --vault <v> --token <registry token id> --card-hash <hex>
```

```bash
node packages/owner-cli/src/cli.ts view --vault <v>
```

Run each one again with `--send` once the dry run looks right.

| Command | Arguments | Notes |
|---|---|---|
| `deploy` | `--module <module.wasm.v1>` | Prints the module reference computed from the file. After sending, success is reported only if the chain's `ModuleDeployed` reference matches. |
| `init` | `--module-ref --agent --per-tx-cap --daily-cap --registry [--energy]` | **No default registry.** Use the official CIS-8004 testnet instance, confirmed on the operator box. Prints the new vault address. |
| `deposit` | `--vault --amount` | Attaches the amount to `deposit`. |
| `withdraw` | `--vault --amount` | Pays the owner's account only. Works while paused. |
| `set-caps` | `--vault --per-tx-cap --daily-cap` | `0 < per-tx ≤ daily`. |
| `set-agent` | `--vault --agent` | The vault refuses the owner as agent (`-4 AgentIsOwner`). |
| `pause`, `unpause` | `--vault` | |
| `add-provider` | `--vault --token --card-hash` | Take both values from `claw-pay-badge-check`'s last line. |
| `remove-provider` | `--vault --token` | |
| `view` | `--vault` | Read-only: owner, agent, registry, caps, paused, balance, today's spend, next nonce, receipt head. |
| `provider` | `--vault --token` | Read-only: the approved card hash, or "not allowlisted". |

Exit codes:
- `0`: ok.
- `1`: rejected (dry run or on chain), or a deploy whose module reference doesn't match.
- `2`: usage error, wrong network, or a key or node problem.

## Order of setup

1. Build the module with `cargo concordium build`.
2. `deploy`.
3. `init`, with the agent account and the official registry.
4. `deposit`.
5. For each provider, run `claw-pay-badge-check`, then `add-provider`.
6. Check the result with `view`.

The full testnet runbook, including the seller demo and the agent, arrives with PR 5d.

## Tests

```bash
npm test --workspace @claw-pay-concordium/owner-cli
```

All offline:
- The encoders and the reject-code table are tested against `fixtures/owner-params.v1.json`, which the contract tests write.
- The CLI tests run against the node adapter's in-memory fake node, with an in-memory owner key. They check:
  - a dry run sends nothing,
  - `--send` submits one correctly built transaction,
  - a rejected dry run is never sent,
  - deploy and init outcomes are reported correctly.
