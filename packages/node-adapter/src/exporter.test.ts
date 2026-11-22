import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseEventsFile, verify } from "@claw-pay-concordium/verifier";

import { ExportError, exportVaultEvents } from "./exporter.ts";
import { blockHash, fakeNode, goldenChain, goldenEventsJson } from "./fake-node.ts";

describe("exportVaultEvents", () => {
  test("reproduces the golden events and view from finalized blocks, and the verifier accepts it", async () => {
    const { node, vault } = goldenChain();
    const seen: bigint[] = [];
    const result = await exportVaultEvents({ client: node, vault, fromHeight: 100n, onBlock: (h) => seen.push(h) });
    const golden = goldenEventsJson();
    assert.deepEqual(result.file.events, golden.events);
    assert.deepEqual(result.file.view, golden.view, "view read at the toHeight block, not the latest");
    assert.deepEqual(result.file.vault, golden.vault);
    assert.equal(result.toHeight, 110n);
    assert.equal(seen.length, 11);
    const report = verify(parseEventsFile(result.file));
    assert.equal(report.ok, true, JSON.stringify(report.issues));
    assert.equal(report.receipts.length, 4);
  });

  test("never reads beyond the last finalized height", async () => {
    const { node, vault } = goldenChain();
    await assert.rejects(exportVaultEvents({ client: node, vault, fromHeight: 100n, toHeight: 111n }), ExportError);
    await assert.rejects(exportVaultEvents({ client: node, vault, fromHeight: 105n, toHeight: 104n }), ExportError);
  });

  test("an export that starts after the vault's init fails verification", async () => {
    const { node, vault } = goldenChain();
    const result = await exportVaultEvents({ client: node, vault, fromHeight: 102n });
    assert.equal(verify(parseEventsFile(result.file)).ok, false);
  });

  test("a stopping point before the end leaves the head unmatched", async () => {
    const { node, vault } = goldenChain();
    const partial = await exportVaultEvents({ client: node, vault, fromHeight: 100n, toHeight: 105n });
    // The view at 105 is not in the fake, so it falls back to "latest" (next_nonce 99): the verifier refuses the mismatch.
    assert.equal(verify(parseEventsFile(partial.file)).ok, false);
  });

  test("a height with no block, or with two, is refused", async () => {
    const { vault } = goldenChain();
    const gap = fakeNode({ blocks: [{ height: 1n, hash: blockHash(1), items: [] }, { height: 3n, hash: blockHash(3), items: [] }], lastFinalizedHeight: 3n });
    await assert.rejects(exportVaultEvents({ client: gap, vault, fromHeight: 1n }), /exactly one finalized block at height 2/);
    const fork = fakeNode({ blocks: [{ height: 1n, hash: blockHash(1), items: [] }, { height: 1n, hash: blockHash(2), items: [] }], lastFinalizedHeight: 1n });
    await assert.rejects(exportVaultEvents({ client: fork, vault, fromHeight: 1n }), /exactly one finalized block at height 1/);
  });
});
