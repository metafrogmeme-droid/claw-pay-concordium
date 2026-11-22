import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress, Parameter, type AccountInfo, type BlockItemSummaryInBlock } from "@concordium/web-sdk";
import type { Transaction } from "@concordium/web-sdk/transactions";
import { CONCORDIUM_TESTNET, VaultExactFacilitator, newRequirements } from "@claw-pay-concordium/x402-vault";
import { addressOf, ephemeralAccount, paymentFor, receiptEventFor } from "@claw-pay-concordium/x402-vault/test-support";

import {
  blockHash,
  failedItem,
  fakeNode,
  interrupted,
  rejectedInvoke,
  resumed,
  successInvoke,
  updateItem,
  updated,
  viewBytes,
  type FakeNodeOptions,
} from "./fake-node.ts";
import { nodeVaultChain } from "./vault-chain.ts";

const VAULT = ContractAddress.create(1, 0);
const REGISTRY = ContractAddress.create(0, 0);
const SELLER = addressOf(0x03);
const agentKey = ephemeralAccount(0x02);
const sponsorKey = ephemeralAccount(0x09);
const MESSAGE = new Uint8Array(56).fill(1);

function messageOf(transaction: Transaction.Finalized): Uint8Array {
  const payload = transaction.payload;
  assert.ok("message" in payload);
  return Parameter.toBuffer(payload.message);
}

function inBlock(summary: BlockItemSummaryInBlock["summary"]): Promise<BlockItemSummaryInBlock> {
  return Promise.resolve({ blockHash: blockHash(1), summary });
}

describe("nodeVaultChain", () => {
  test("dryRunPay returns the vault's events, across an interrupt", async () => {
    const node = fakeNode({
      pay: () => successInvoke([interrupted(VAULT, []), updated(REGISTRY, []), resumed(VAULT), updated(VAULT, [new Uint8Array([8, 1])])]),
    });
    const result = await nodeVaultChain(node).dryRunPay(VAULT, agentKey.address, MESSAGE, 30_000n);
    assert.deepEqual(result, { ok: true, events: [new Uint8Array([8, 1])] });
  });

  test("dryRunPay passes the vault's reject code through", async () => {
    const node = fakeNode({ pay: () => rejectedInvoke(-11) });
    const result = await nodeVaultChain(node).dryRunPay(VAULT, agentKey.address, MESSAGE, 30_000n);
    assert.deepEqual(result, { ok: false, rejectCode: -11, message: "RejectedReceive" });
  });

  test("getVaultAgent reads the view", async () => {
    const node = fakeNode({ views: new Map([["latest", viewBytes({ agent: agentKey.address })]]) });
    assert.ok(AccountAddress.equals(await nodeVaultChain(node).getVaultAgent(VAULT), agentKey.address));
  });

  test("waitForFinalization only for transactions it submitted", async () => {
    await assert.rejects(nodeVaultChain(fakeNode()).waitForFinalization("ab".repeat(32), 1000), /submitted through this chain/);
  });
});

describe("the facilitator through the node adapter", () => {
  const requirements = newRequirements({
    network: CONCORDIUM_TESTNET,
    amount: 1_000_000n,
    payTo: AccountAddress.toBase58(SELLER),
    feePayer: AccountAddress.toBase58(sponsorKey.address),
    provider: 10n,
  });

  function setup(overrides: Partial<FakeNodeOptions> = {}): { facilitator: VaultExactFacilitator; node: ReturnType<typeof fakeNode> } {
    const node = fakeNode({
      accounts: new Map([[AccountAddress.toBase58(agentKey.address), agentKey.account as unknown as AccountInfo]]),
      views: new Map([["latest", viewBytes({ agent: agentKey.address })]]),
      pay: (invoker, message) => successInvoke([updated(VAULT, [receiptEventFor(VAULT, invoker ?? agentKey.address, message, SELLER)])]),
      finalization: (sent) => inBlock(updateItem([interrupted(VAULT, []), updated(REGISTRY, []), resumed(VAULT), updated(VAULT, [receiptEventFor(VAULT, agentKey.address, messageOf(sent), SELLER)])])),
      ...overrides,
    });
    const facilitator = new VaultExactFacilitator({
      network: CONCORDIUM_TESTNET,
      sponsor: { address: sponsorKey.address, signer: sponsorKey.signer },
      vaults: [VAULT],
      maxEnergy: 50_000n,
      chain: nodeVaultChain(node),
    });
    return { facilitator, node };
  }

  async function payment(): Promise<Awaited<ReturnType<typeof paymentFor>>> {
    return paymentFor(requirements, { vault: VAULT, agent: agentKey, nowMs: Date.now() });
  }

  test("verifies, dry-runs, submits and confirms the receipt", async () => {
    const { facilitator, node } = setup();
    const result = await facilitator.settle(await payment(), requirements);
    assert.equal(result.success, true, result.errorMessage);
    assert.equal(result.transaction, "ab".repeat(32));
    assert.equal(node.sent.length, 1);
    assert.deepEqual(node.calls.filter((call) => call !== "invokeContract:guard_vault.view"), [
      "getAccountInfo",
      "invokeContract:guard_vault.pay",
      "sendTransaction",
      "waitForTransactionFinalization",
    ]);
  });

  test("a vault rejection in the dry run stops it before submitting", async () => {
    const { facilitator, node } = setup({ pay: () => rejectedInvoke(-6) });
    const result = await facilitator.settle(await payment(), requirements);
    assert.equal(result.errorReason, "dry_run_rejected");
    assert.match(result.errorMessage ?? "", /reject code -6/);
    assert.equal(node.sent.length, 0);
  });

  test("an on-chain rejection is transaction_rejected", async () => {
    const { facilitator } = setup({ finalization: () => inBlock(failedItem(-11)) });
    const result = await facilitator.settle(await payment(), requirements);
    assert.equal(result.errorReason, "transaction_rejected");
  });

  test("a timeout or an undecodable outcome is finalization_timeout", async () => {
    const timedOut = setup({ finalization: () => Promise.reject(new Error("Function timed out.")) });
    assert.equal((await timedOut.facilitator.settle(await payment(), requirements)).errorReason, "finalization_timeout");
    const unknown = setup({ finalization: () => inBlock(null) });
    assert.equal((await unknown.facilitator.settle(await payment(), requirements)).errorReason, "finalization_timeout");
  });
});
