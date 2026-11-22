import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TESTNET_GENESIS, fakeNode } from "./fake-node.ts";
import {
  NodeAddressError,
  WrongNetworkError,
  assertTestnetNode,
  connectTestnetNode,
  parseNodeAddress,
} from "./node-client.ts";

const MAINNET_LIKE = "9dd9ca4d19e9393877d2c44b70f89acbfc0883c2243e5eeaecc0d1cd0503f478";

describe("testnet node guard", () => {
  test("accepts a node on testnet", async () => {
    await assertTestnetNode(fakeNode({ genesis: TESTNET_GENESIS }));
  });

  test("refuses any other genesis block", async () => {
    await assert.rejects(assertTestnetNode(fakeNode({ genesis: MAINNET_LIKE })), WrongNetworkError);
    await assert.rejects(assertTestnetNode(fakeNode({ genesis: "00".repeat(32) })), WrongNetworkError);
  });

  test("connectTestnetNode checks the network before handing the client out", async () => {
    const created: [string, number][] = [];
    const node = fakeNode({ genesis: MAINNET_LIKE });
    await assert.rejects(
      connectTestnetNode({ CLAW_PAY_NODE: "node.example:20000" }, (host, port) => {
        created.push([host, port]);
        return node;
      }),
      /testnet only/,
    );
    assert.deepEqual(created, [["node.example", 20000]]);
    assert.deepEqual(node.calls, ["getConsensusStatus"], "nothing else is asked of a wrong-network node");

    const testnet = fakeNode();
    assert.equal(await connectTestnetNode({ CLAW_PAY_NODE: "node.example:20000" }, () => testnet), testnet);
  });

  test("parses host:port and refuses anything else", () => {
    assert.deepEqual(parseNodeAddress("grpc.node.example:20000"), { host: "grpc.node.example", port: 20000 });
    for (const bad of [undefined, "", "node.example", "node.example:0", "node.example:70000", "https://node.example:20000", "node.example:20000/x"]) {
      assert.throws(() => parseNodeAddress(bad), NodeAddressError, String(bad));
    }
  });
});
