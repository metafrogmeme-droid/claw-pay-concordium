# Node adapter

This package connects Claw Pay for Concordium to a **Concordium testnet node**. It provides:
- `VaultChain` for the x402 `vault-exact` facilitator,
- `AgentChain` for the agent client,
- a decoder for the vault's `view`,
- `claw-pay-export`, which exports the vault's finalized events for `claw-pay-verify` and reconciles the agent's local receipt log against them.

**Operator box only.** The live code connects to a node, so it runs only where the operator runs testnet steps. The tests in this repository use an in-memory fake node and never open a connection.

## Testnet guard

`connectTestnetNode(env)`:
- reads `CLAW_PAY_NODE` (`host:port`),
- connects over TLS,
- **before anything else**, checks that the node's genesis block hash starts with `4221332d34e1694168c2a0c0b3fd0f27`, the Concordium testnet reference in the CAIP-2 id `ccd:4221332d34e1694168c2a0c0b3fd0f27`.

Any other network is refused. `claw-pay-export` also requires `CLAW_PAY_NETWORK=testnet` before it connects.

For example, Concordium's public testnet gRPC endpoint is `CLAW_PAY_NODE=grpc.testnet.concordium.com:20000`. Check the current endpoint in Concordium's docs. You can also run your own node.

## What it reads and sends

| Piece | Node calls |
|---|---|
| `readVaultView` | `invokeContract` → `guard_vault.view`, at a given block or the last finalized one. The result is decoded from exactly 161 bytes. |
| `nodeVaultChain` (facilitator) | `getAccountInfo`, `invokeContract` (dry run of `pay` as the agent), `sendTransaction` (the sponsored transaction), `waitForTransactionFinalization` |
| `nodeAgentChain` (client) | `view` for the vault's next nonce and today's spend, and `getNextAccountNonce` for the agent |
| `exportVaultEvents` | `getConsensusStatus`, then `getBlocksAtHeight` and `getBlockTransactionEvents` for each finalized height, then `view` at the last block |

**Where the vault's events come from:**
- `ContractInitialized` (init),
- `Updated`,
- `Interrupted`: when `pay` calls the registry, events logged before the call appear here.

They are collected in trace order. If the SDK reports an entry it cannot decode, the adapter **refuses** it rather than skip it, so a receipt can never go missing silently. Update the SDK if this happens.

**A finalization that times out**, or a stream that is lost after submission, is reported as `timeout`. The outcome is unknown, so the facilitator returns `finalization_timeout` and the agent client counts the payment as spent.

## Export and verify

```bash
CLAW_PAY_NETWORK=testnet CLAW_PAY_NODE=<host:port> \
  node packages/node-adapter/src/export-cli.ts --vault <index>[,<subindex>] --from-height <init block height> --out events.json
```

```bash
node packages/verifier/src/cli.ts events.json
```

- **Range:** `--from-height` must be at or before the vault's init block. `--to-height` defaults to the last finalized height and may not exceed it.
- **Snapshot:** the view is read at the last scanned block, so the events and the head are one consistent snapshot.
- **Incomplete exports fail:** an export that starts after init, or that stops before the view's head, fails verification.

The exporter trusts the node to report blocks honestly. The verifier's head check catches omitted events only while the view is honest. Use a node you trust, re-export from a second node, or cross-check on CCDExplorer.

## Reconcile the local receipt log

Add `--log <receipts.jsonl>` to print a reconcile report. It sorts the agent's local log against the on-chain receipts, matched by invoice hash:

| Line | Meaning |
|---|---|
| confirmed on chain | Settled locally, with a matching receipt on chain (amount, provider and payee checked). |
| settled locally but not on chain | Not finalized yet, or the seller misreported. |
| landed despite a local failure | The payment went through although the client logged a failure or never saw an outcome. |
| receipt disagrees with the log | Amount, provider or payee differ. |
| on chain but not in the log | Receipts the local log doesn't know. |

The exit code is 1 if any line other than "confirmed" is non-empty. The report never edits the log.

## Tests

```bash
npm test --workspace @claw-pay-concordium/node-adapter
```

All offline, against an in-memory fake node that returns objects in the SDK's shapes:
- The view decoder is tested against `fixtures/vault-view.v1.json`, written by the contract tests from the same scenario as the golden events.
- The exporter test spreads the 13 golden events across fake finalized blocks. These include the init, a `pay` whose receipt sits in an `Interrupted` entry, another contract's events, a failed transaction and empty blocks. The test checks the export equals the golden file and passes `verify`.
- The facilitator runs end to end over `nodeVaultChain` on the fake node.
