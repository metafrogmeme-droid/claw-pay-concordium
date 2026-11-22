# Testnet demo runbook

This walks the operator through the end-to-end demo on **Concordium testnet**:
- deploy a `GuardVault` and fund it,
- allowlist a registry-verified seller,
- the agent pays the seller over x402 `vault-exact` through the vault,
- export the receipts and verify them.

**Run it on the operator box only.**
- Testnet only, with throwaway keys and test CCD.
- Never commit a key, a wallet export, a receipt log or a config with a key path that matters.
- Every state-changing owner step is a dry run first. Read it, then run it again with `--send`.

All commands run from the repository root, after `npm ci --ignore-scripts`. Amounts are in micro-CCD (1 CCD = 1 000 000).

## 0. Prerequisites

- Node 22.18 or later.
- To build the module: Rust (the toolchain in `rust-toolchain.toml`) and `cargo-concordium` 5.0.0.
- A Concordium **testnet** gRPC endpoint, as `host:port`. Concordium runs a public one; check its current address in Concordium's docs, or run your own node.

Set these in every shell you use:

```bash
export CLAW_PAY_NETWORK=testnet
```

```bash
export CLAW_PAY_NODE=<testnet host>:<port>
```

Every tool refuses any network other than testnet. The node is refused unless its genesis block hash starts with `4221332d34e1694168c2a0c0b3fd0f27`.

## 1. Four throwaway testnet accounts

| Account | Role | Funds |
|---|---|---|
| owner | Deploys, inits, funds and controls the vault | Enough for deploy and init fees plus the deposit |
| agent | Signs `pay` calls only. The sponsor pays its fees. | None needed |
| sponsor | Pays transaction fees for the agent's payments | A little, for fees |
| seller wallet | The seller's registry `agent_wallet`, which receives payments | None needed |

1. Create each account in a Concordium wallet on testnet, and fund the owner and sponsor from the testnet faucet.
2. Export each account you sign with (owner, agent, sponsor) as a wallet export: a JSON file with `type`, `v`, `environment` and `value`.
3. Keep the exports **outside the repository**, and run `chmod 600` on each.

The tools refuse a key file that group or others can read, one owned by another user, and any export whose `environment` isn't `testnet`.

## 2. Confirm the open verification items

These are listed in `THREAT_MODEL.md` under "Open verification":
- **Registry address.** Find the official CIS-8004 Agent Registry instance on testnet (`<index>,<subindex>`) from Concordium's docs. The vault trusts it for life.
- **Testnet genesis hash.** If the node guard refuses your testnet node, stop: the expected prefix is wrong, and it needs fixing in code, not bypassing.
- **Badge definition.** Confirm "Verified by Concordium" against Concordium's docs.

## 3. The seller in the Agent Registry

The seller must be an **Active** agent in the official registry, with:
- an `agent_wallet` (the seller wallet above), which becomes the seller's `payTo`,
- an Agent Card at `agent_uri` whose SHA-256 is the on-chain `metadata_hash`.

Register it with the registry's own tooling; this repository doesn't register agents. Note its **token id**.

Then check the badge and get the card hash:
- Save the registry's `agentOf` reply for the token, as described in `packages/badge-check/README.md`, under "Input".
- Then run:

```bash
node packages/badge-check/src/cli.ts <agent-of.json>
```

The last line is the `add_provider` parameter: `{"token_id": …, "card_hash": "…"}`.

## 4. Build, deploy and set up the vault

```bash
(cd contracts/guard-vault && cargo concordium build --out concordium-out/module.wasm.v1)
```

```bash
export CLAW_PAY_OWNER_KEY_FILE=/secure/owner.export
```

Run each step below as shown (a dry run), read the output, then run it again with `--send` added.

1. Deploy. The output prints the module reference.

```bash
node packages/owner-cli/src/cli.ts deploy --module contracts/guard-vault/concordium-out/module.wasm.v1
```

2. Init. Use caps you're happy to lose in a demo. The output prints the new vault address.

```bash
node packages/owner-cli/src/cli.ts init --module-ref <module ref> --agent <agent account> --per-tx-cap 2000000 --daily-cap 10000000 --registry <registry index,subindex>
```

Look up the init transaction on CCDExplorer (testnet), and note its **block height** for step 7.

3. Fund the vault.

```bash
node packages/owner-cli/src/cli.ts deposit --vault <vault> --amount 20000000
```

4. Allowlist the seller with the values from step 3.

```bash
node packages/owner-cli/src/cli.ts add-provider --vault <vault> --token <seller token id> --card-hash <card hash>
```

5. Check the result.

```bash
node packages/owner-cli/src/cli.ts view --vault <vault>
```

If a dry run is rejected, the reject code is named, for example `-4 AgentIsOwner` or `-16 ProviderNotActive`. Fix the cause; a rejected dry run can't be sent.

## 5. Start the seller

Write a seller config outside the repository, for example `/secure/seller.json`:

```json
{
  "listen": { "host": "127.0.0.1", "port": 8402 },
  "provider": "<seller token id>",
  "payTo": "<seller agent_wallet>",
  "vaults": ["<vault index>,<vault subindex>"],
  "maxEnergy": "50000",
  "routes": [
    { "path": "/weather", "price": "1000000", "contentType": "application/json", "body": "{\"forecast\":\"sunny\"}" },
    { "path": "/premium", "price": "5000000", "contentType": "text/plain", "body": "premium content" }
  ]
}
```

```bash
CLAW_PAY_SELLER_CONFIG=/secure/seller.json CLAW_PAY_SPONSOR_KEY_FILE=/secure/sponsor.export node packages/demo/src/seller-cli.ts
```

The seller prints its URL, the fee payer (sponsor) address, and the routes. Keep it running.

## 6. Run the agent

Write the agent's spend policy, for example `/secure/policy.json`:
- Its caps must be at or below the vault's.
- `feePayers` is the sponsor address the seller printed.
- `maxEnergy` must not be above the seller's.

```json
{
  "vault": { "index": "<vault index>", "subindex": "<vault subindex>" },
  "perPaymentMax": "2000000",
  "dailyMax": "10000000",
  "maxTimeoutSeconds": 60,
  "maxEnergy": "30000",
  "providers": [{ "origin": "http://127.0.0.1:8402", "provider": "<seller token id>", "payTo": "<seller agent_wallet>" }],
  "feePayers": ["<sponsor account>"]
}
```

```bash
export CLAW_PAY_POLICY_FILE=/secure/policy.json CLAW_PAY_RECEIPT_LOG=/secure/receipts.jsonl CLAW_PAY_AGENT_KEY_FILE=/secure/agent.export
```

```bash
node packages/demo/src/agent-cli.ts http://127.0.0.1:8402/weather
```

The agent prints `HTTP 200`, then the receipt-log entries (`attempt`, then `settled` with the transaction hash), then the body.

If the facilitator reports `dry_run_rejected` with `OutOfEnergy`, raise `maxEnergy` in both the policy and the seller config, and try again.

**Negative checks for the video:**
- **Over the agent's cap:** `node packages/demo/src/agent-cli.ts http://127.0.0.1:8402/premium` gives `payment refused by spend-policy: over_per_payment`. Nothing is signed, and the seller sees no payment.
- **Paused vault:** run `pause --vault <vault>` with `--send`, then rerun the agent for `/weather`. The facilitator's dry run is rejected, nothing is submitted, and the agent logs `failed`. Then run `unpause`.
- **Seller names another provider:** in a copy of the policy, set the provider's token id to a different one, and point `CLAW_PAY_POLICY_FILE` at it. The agent refuses the seller's offer with `provider_mismatch`, before signing.

## 7. Export and verify the receipts

```bash
node packages/node-adapter/src/export-cli.ts --vault <vault> --from-height <init block height> --out /secure/events.json --log /secure/receipts.jsonl
```

```bash
node packages/verifier/src/cli.ts /secure/events.json
```

- **Export:** reads finalized blocks only, with the vault's view at the same block. The `--log` report should show every payment "confirmed on chain".
- **Verify:** rebuilds the receipt chain from the events alone and checks every hash, link and rule, ending at the vault's head.

**Evidence for the submission:** look up the vault address and each payment's transaction hash on CCDExplorer (testnet).

## 8. Teardown

Run `pause --vault <vault>` with `--send`. Then run `withdraw` with `--send` for the remaining balance (`view` shows it). Delete the exports when the demo is over.

## Where the safety comes from

| What stops a bad payment | Where |
|---|---|
| Caps, allowlist, registry check, nonce, invoice, pause | The vault contract, on chain |
| Requested-origin check, per-payment and daily caps, fee payers | The agent's spend-policy |
| Reused invoices, stale nonces, one payment at a time | The agent's replay-guard |
| Anything but a capped `pay` on the agent's own vault | The capped signer |
| Unknown, reused, cross-resource, changed or expired invoices | The seller's invoice book |
| Fee griefing (only `pay`, only configured vaults, energy cap, 60 s expiry, dry run first) | The facilitator |
