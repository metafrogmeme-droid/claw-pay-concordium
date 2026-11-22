import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";

import { SellerConfigError, parseSellerConfig } from "./seller-config.ts";

const VALID = {
  listen: { host: "127.0.0.1", port: 8402 },
  provider: "10",
  payTo: AccountAddress.toBase58(addressOf(0x03)),
  vaults: ["7,0", "8"],
  maxEnergy: "50000",
  routes: [{ path: "/weather", price: "1000000", contentType: "application/json", body: '{"forecast":"sunny"}' }],
};

describe("parseSellerConfig", () => {
  test("parses a valid config", () => {
    const config = parseSellerConfig(VALID);
    assert.deepEqual(config.listen, { host: "127.0.0.1", port: 8402 });
    assert.equal(config.provider, 10n);
    assert.equal(config.vaults.length, 2);
    assert.ok(ContractAddress.equals(config.vaults[1] ?? ContractAddress.create(0, 0), ContractAddress.create(8, 0)));
    assert.equal(config.routes[0]?.price, 1_000_000n);
  });

  test("listen defaults to 127.0.0.1:8402", () => {
    const { listen, ...rest } = VALID;
    assert.ok(listen.port === 8402);
    assert.deepEqual(parseSellerConfig(rest).listen, { host: "127.0.0.1", port: 8402 });
  });

  test("refuses invalid configs, including a non-loopback host", () => {
    const route = VALID.routes[0];
    const bad: unknown[] = [
      null,
      { ...VALID, listen: { host: "0.0.0.0", port: 8402 } },
      { ...VALID, listen: { host: "seller.example", port: 8402 } },
      { ...VALID, listen: { host: "127.0.0.1", port: 70_000 } },
      { ...VALID, provider: 10 },
      { ...VALID, payTo: "nope" },
      { ...VALID, vaults: [] },
      { ...VALID, vaults: ["7,0,1"] },
      { ...VALID, maxEnergy: "0" },
      { ...VALID, routes: [] },
      { ...VALID, routes: [{ ...route, price: "0" }] },
      { ...VALID, routes: [{ ...route, price: "1.5" }] },
      { ...VALID, routes: [{ ...route, path: "weather" }] },
      { ...VALID, routes: [{ ...route, path: "/health" }] },
      { ...VALID, routes: [{ ...route, path: "/a?b=1" }] },
      { ...VALID, routes: [{ ...route, contentType: "" }] },
      { ...VALID, routes: [{ ...route, body: "x".repeat(64 * 1024 + 1) }] },
      { ...VALID, routes: [route, route] },
    ];
    for (const json of bad) {
      assert.throws(() => parseSellerConfig(json), SellerConfigError, JSON.stringify(json).slice(0, 120));
    }
  });
});
