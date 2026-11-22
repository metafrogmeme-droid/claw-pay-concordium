import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ContractAddress, type InvokeContractResult } from "@concordium/web-sdk";
import { DecodeError, fromHex, toHex } from "@claw-pay-concordium/verifier";

import { blockHash, fakeNode, viewBytes, viewFixture } from "./fake-node.ts";
import type { NodeClient } from "./node-client.ts";
import { ViewError, decodeVaultView, readVaultView } from "./vault-view.ts";

const VAULT = ContractAddress.create(1, 0);

describe("decodeVaultView", () => {
  test("matches the view the contract returns (fixture)", () => {
    const { bytes, fields } = viewFixture();
    const view = decodeVaultView(fromHex(bytes));
    assert.equal(toHex(view.owner.decodedAddress), fields["owner"]);
    assert.equal(toHex(view.agent.decodedAddress), fields["agent"]);
    assert.deepEqual({ index: Number(view.registry.index), subindex: Number(view.registry.subindex) }, fields["registry"]);
    assert.equal(String(view.perTxCap), fields["per_tx_cap"]);
    assert.equal(String(view.dailyCap), fields["daily_cap"]);
    assert.equal(view.paused, fields["paused"]);
    assert.equal(String(view.nextNonce), fields["next_nonce"]);
    assert.equal(String(view.currentDay), fields["current_day"]);
    assert.equal(String(view.spentToday), fields["spent_today"]);
    assert.equal(String(view.balance), fields["balance"]);
    assert.equal(toHex(view.receiptHead), fields["receipt_head"]);
  });

  test("needs exactly 161 bytes", () => {
    const bytes = fromHex(viewFixture().bytes);
    assert.throws(() => decodeVaultView(bytes.slice(0, 160)), DecodeError);
    assert.throws(() => decodeVaultView(new Uint8Array([...bytes, 0])), DecodeError);
  });
});

describe("readVaultView", () => {
  test("invokes guard_vault.view at the given block", async () => {
    const at = blockHash(7);
    const node = fakeNode({ views: new Map([[Buffer.from(at.buffer).toString("hex"), viewBytes({ nextNonce: 9n })]]) });
    assert.equal((await readVaultView(node, VAULT, at)).nextNonce, 9n);
    assert.equal((await readVaultView(node, VAULT)).nextNonce, 4n);
    assert.deepEqual(node.calls, ["invokeContract:guard_vault.view", "invokeContract:guard_vault.view"]);
  });

  test("a failed or empty view is an error", async () => {
    const failing: Pick<NodeClient, "invokeContract"> = {
      invokeContract: () => Promise.resolve({ tag: "failure", usedEnergy: 1n, reason: null } as unknown as InvokeContractResult),
    };
    await assert.rejects(readVaultView(failing, VAULT), ViewError);
    const empty: Pick<NodeClient, "invokeContract"> = {
      invokeContract: () => Promise.resolve({ tag: "success", usedEnergy: 1n, events: [] } as unknown as InvokeContractResult),
    };
    await assert.rejects(readVaultView(empty, VAULT), ViewError);
  });
});
