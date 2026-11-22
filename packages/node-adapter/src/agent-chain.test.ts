import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ContractAddress } from "@concordium/web-sdk";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";

import { nodeAgentChain } from "./agent-chain.ts";
import { fakeNode, viewBytes } from "./fake-node.ts";

describe("nodeAgentChain", () => {
  test("reads the vault nonce and today's spend from view, and the agent's sequence number", async () => {
    const node = fakeNode({
      nextNonce: 17n,
      views: new Map([["latest", viewBytes({ nextNonce: 5n, currentDay: 20_780n, spentToday: 2_500_000n })]]),
    });
    const chain = nodeAgentChain(node, ContractAddress.create(1, 0), addressOf(0x02));
    assert.equal(await chain.vaultNonce(), 5n);
    assert.equal(await chain.accountSequence(), 17n);
    assert.deepEqual(await chain.vaultSpentToday(), { day: 20_780, spent: 2_500_000n });
  });
});
