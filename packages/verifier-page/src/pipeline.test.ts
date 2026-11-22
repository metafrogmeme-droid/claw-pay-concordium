import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { ContractAddress } from "@concordium/web-sdk";
import { WrongNetworkError } from "@claw-pay-concordium/node-adapter/browser";
import { fakeNode, goldenChain } from "@claw-pay-concordium/node-adapter/test-support";

import { InputError, checkFile, exportLive, parseHeight, parseNodeUrl, parseVault } from "./pipeline.ts";

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../fixtures/vault-events.v1.json", import.meta.url)), "utf8");

describe("checkFile (offline)", () => {
  test("the golden events file verifies", () => {
    const { report } = checkFile(GOLDEN);
    assert.equal(report.ok, true);
    assert.equal(report.receipts.length, 4);
  });

  test("a tampered file shows issues", () => {
    const json = JSON.parse(GOLDEN) as { events: string[] };
    const receipt = json.events[3] ?? "";
    json.events[3] = `${receipt.slice(0, 40)}${receipt[40] === "0" ? "1" : "0"}${receipt.slice(41)}`;
    const { report } = checkFile(JSON.stringify(json));
    assert.equal(report.ok, false);
    assert.ok(report.issues.length > 0);
  });

  test("junk is an InputError with a readable message", () => {
    assert.throws(() => checkFile("not json"), InputError);
    assert.throws(() => checkFile("{}"), /Not a vault events file/);
  });
});

describe("exportLive", () => {
  test("reads the vault from a testnet node and verifies it", async () => {
    const { node, vault } = goldenChain();
    const heights: bigint[] = [];
    const result = await exportLive({ client: node, vault, fromHeight: 100n, onBlock: (h) => heights.push(h) });
    assert.equal(result.report.ok, true);
    assert.equal(result.report.receipts.length, 4);
    assert.equal(result.toHeight, 110n);
    assert.equal(heights.length, 11);
    assert.equal(result.json.events.length, 13);
  });

  test("a node that is not on testnet is refused before any block is read", async () => {
    const node = fakeNode({ genesis: "9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478" });
    await assert.rejects(exportLive({ client: node, vault: ContractAddress.create(1, 0), fromHeight: 0n }), WrongNetworkError);
    assert.deepEqual(node.calls, ["getConsensusStatus"]);
  });
});

describe("input parsing", () => {
  test("node URLs: https, or plain http on loopback only", () => {
    assert.deepEqual(parseNodeUrl("https://grpc.node.example:20000"), { address: "https://grpc.node.example", port: 20000 });
    assert.deepEqual(parseNodeUrl(" https://node.example "), { address: "https://node.example", port: 443 });
    assert.deepEqual(parseNodeUrl("http://localhost:20000"), { address: "http://localhost", port: 20000 });
    assert.deepEqual(parseNodeUrl("http://127.0.0.1:8080/"), { address: "http://127.0.0.1", port: 8080 });
    for (const bad of ["http://node.example:20000", "ftp://node.example", "node.example:20000", "", "https://user:pw@node.example", "https://node.example/path", "https://node.example/?q=1"]) {
      assert.throws(() => parseNodeUrl(bad), InputError, bad);
    }
  });

  test("vaults and heights", () => {
    assert.ok(ContractAddress.equals(parseVault("7"), ContractAddress.create(7, 0)));
    assert.ok(ContractAddress.equals(parseVault(" 7 , 2 "), ContractAddress.create(7, 2)));
    for (const bad of ["", "x", "7,", "1,2,3", "-1"]) {
      assert.throws(() => parseVault(bad), InputError, bad);
    }
    assert.equal(parseHeight("120", "From"), 120n);
    assert.equal(parseHeight(" ", "To", true), undefined);
    assert.throws(() => parseHeight("", "From"), InputError);
    assert.throws(() => parseHeight("1.5", "From"), InputError);
  });
});
