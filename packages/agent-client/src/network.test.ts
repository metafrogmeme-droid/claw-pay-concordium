import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ALLOWED_NETWORK, assertTestnet } from "./network.ts";

describe("assertTestnet", () => {
  test("accepts testnet", () => {
    assert.equal(ALLOWED_NETWORK, "testnet");
    assert.doesNotThrow(() => {
      assertTestnet("testnet");
    });
  });

  for (const network of ["mainnet", "stagenet", "", "Testnet", "TESTNET", " testnet", "testnet\n"]) {
    test(`rejects ${JSON.stringify(network)}`, () => {
      assert.throws(() => {
        assertTestnet(network);
      }, /testnet only/);
    });
  }

  for (const value of [undefined, null, 0, true, {}, ["testnet"]]) {
    test(`rejects non-string value (${Array.isArray(value) ? "array" : typeof value})`, () => {
      assert.throws(() => {
        assertTestnet(value);
      }, /testnet only/);
    });
  }
});
