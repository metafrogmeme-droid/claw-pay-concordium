# x402 vault-exact

The `vault-exact` x402 scheme for Concordium testnet. With it, a seller can charge an AI agent per request while the payment goes **through the agent's `GuardVault`**, so the vault's caps, allowlist, registry check and receipts apply to every paid request.

The full spec, with every verification rule, is in [`docs/x402-vault-scheme.md`](../../docs/x402-vault-scheme.md).

**Spike status.** The scheme, the agent client and the facilitator are implemented and tested offline against an in-memory chain. This package does **not** yet talk to a Concordium node. The live chain adapter and an HTTP seller demo come in PR 5 and run on the operator box.

## What is in it

| File | What it does |
|---|---|
| `src/scheme.ts` | Constants, `PayParams` encoding (matches the contract byte for byte), offer validation, the invoice hash, and `newRequirements` for sellers. |
| `src/client.ts` | `createVaultPayment` and `VaultExactClient` (an `@x402/core` `SchemeNetworkClient`). Builds and signs the agent's sponsored `guard_vault.pay` transaction. |
| `src/facilitator.ts` | `VaultExactFacilitator` (an `@x402/core` `SchemeNetworkFacilitator`). Verifies, co-signs as sponsor, submits and confirms the receipt. |
| `src/chain.ts` | The `VaultChain` interface the facilitator needs from a node. Interface only. |
| `src/test-support.ts` | **Test-only** helpers (in-memory `FakeChain`, ephemeral accounts, payment builder), exported as `./test-support` for other packages' offline tests. |

Dependencies, pinned exactly and installed with `--ignore-scripts`:
- `@concordium/web-sdk` 12.0.2,
- `@x402/core` 2.30.0,
- the workspace `@claw-pay-concordium/verifier`, which decodes vault events.

## Seller: make an offer

```ts
import { CONCORDIUM_TESTNET, newRequirements } from "@claw-pay-concordium/x402-vault";

const requirements = newRequirements({
  network: CONCORDIUM_TESTNET,
  amount: 1_000_000n, // micro-CCD
  payTo: sellerAgentWallet, // the seller's registry agent_wallet, Base58
  feePayer: sponsorAccount, // from the facilitator's getExtra()
  provider: 10n, // the seller's registry token id
});
```

Each call gets a fresh `invoiceId`. Remember which resource it was issued for, and serve only that resource for it.

## Agent: pay

```ts
import { VaultExactClient, signWith } from "@claw-pay-concordium/x402-vault";

const client = new VaultExactClient({
  vault, // the agent's GuardVault ContractAddress
  agent, // the agent AccountAddress
  sign: signWith(signer), // or the agent client's capped signer; the key is loaded on the operator box only
  energy: 30_000n,
  vaultNonce: readVaultNextNonce, // () => Promise<bigint>, from the vault's view
  accountSequence: readAgentSequence, // () => Promise<bigint>, the agent account's next nonce
});
```

`client.createPaymentPayload(2, requirements)` returns the x402 payload.

Signing takes a `TransactionSigner`, which sees the whole transaction before the key is used. `signWith(accountSigner)` signs anything. The agent client wraps the key in a capped signer instead: it refuses anything but a capped `pay` on the agent's own vault.

## Facilitator: verify and settle

```ts
import { CONCORDIUM_TESTNET, VaultExactFacilitator } from "@claw-pay-concordium/x402-vault";

const facilitator = new VaultExactFacilitator({
  network: CONCORDIUM_TESTNET,
  sponsor: { address: sponsorAccount, signer: sponsorSigner },
  vaults: [vault], // only these vaults are sponsored
  maxEnergy: 50_000n,
  chain, // a VaultChain; the live one comes in PR 5
});
```

`verify` returns `{ isValid, invalidReason }`, with one reason per rule. `settle` co-signs, submits, waits for finalization and requires a matching vault `Receipt`. Before any co-signing it dry-runs `pay` and enforces the decision 8 limits.

## Keys

This package never reads, stores or logs keys. Signers are passed in by the caller. The tests generate fresh ed25519 keys in memory for each run, build fake account records for them, and drop them at the end. They are never written to disk, funded or used on any network.

## Tests

```bash
npm test --workspace @claw-pay-concordium/x402-vault
```

What the tests cover:
- the encoder against the contract's own `PayParams` bytes (`fixtures/pay-params.v1.json`),
- the agent's transaction, checked with the SDK's real signature verification,
- each facilitator rule, each with its own failing payment,
- settlement success, timeout, on-chain rejection, a missing receipt, and the in-flight lock.
