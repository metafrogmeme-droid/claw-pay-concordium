import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AccountAddress } from "@concordium/web-sdk";
import { DecodeError, fromHex, toHex } from "@claw-pay-concordium/verifier";
import type { PaymentRequirements } from "@x402/core/types";

import {
  CONCORDIUM_TESTNET,
  RequirementsError,
  decodePayParams,
  encodePayParams,
  invoiceHash,
  newRequirements,
  parseRequirements,
} from "./scheme.ts";
import { addressOf } from "./test-support.ts";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/pay-params.v1.json", import.meta.url));

interface FixtureCase {
  provider: string;
  amount: string;
  nonce: string;
  invoice_hash: string;
  bytes: string;
}

const CASES = (JSON.parse(readFileSync(FIXTURE, "utf8")) as { cases: FixtureCase[] }).cases;

const SELLER = AccountAddress.toBase58(addressOf(0x03));
const SPONSOR = AccountAddress.toBase58(addressOf(0x09));

function offer(): PaymentRequirements {
  return newRequirements({
    network: CONCORDIUM_TESTNET,
    amount: 1_000_000n,
    payTo: SELLER,
    feePayer: SPONSOR,
    provider: 10n,
  });
}

describe("PayParams encoding", () => {
  test("matches the bytes the contract produces (fixture)", () => {
    assert.ok(CASES.length >= 2);
    for (const c of CASES) {
      const params = {
        provider: BigInt(c.provider),
        amount: BigInt(c.amount),
        nonce: BigInt(c.nonce),
        invoiceHash: fromHex(c.invoice_hash),
      };
      assert.equal(toHex(encodePayParams(params)), c.bytes);
      assert.deepEqual(decodePayParams(fromHex(c.bytes)), params);
    }
  });

  test("decoding needs exactly 56 bytes", () => {
    const bytes = fromHex(CASES[0]?.bytes ?? "");
    assert.throws(() => decodePayParams(bytes.slice(0, 55)), DecodeError);
    assert.throws(() => decodePayParams(new Uint8Array([...bytes, 0])), DecodeError);
  });

  test("refuses values that do not fit", () => {
    const base = { provider: 1n, amount: 1n, nonce: 0n, invoiceHash: new Uint8Array(32) };
    assert.throws(() => encodePayParams({ ...base, provider: 1n << 64n }), RangeError);
    assert.throws(() => encodePayParams({ ...base, amount: -1n }), RangeError);
    assert.throws(() => encodePayParams({ ...base, invoiceHash: new Uint8Array(31) }), RangeError);
  });
});

describe("requirements and invoice hash", () => {
  test("newRequirements gives a valid offer with a fresh invoice id each time", () => {
    const a = parseRequirements(offer());
    const b = parseRequirements(offer());
    assert.equal(a.amount, 1_000_000n);
    assert.equal(a.provider, 10n);
    assert.notDeepEqual(a.invoiceId, b.invoiceId);
  });

  test("the invoice hash is deterministic and covers every field", () => {
    const base = parseRequirements(offer());
    assert.deepEqual(invoiceHash(base), invoiceHash({ ...base }));
    const variants = [
      { ...base, network: "ccd:00000000000000000000000000000000" as const },
      { ...base, amount: base.amount + 1n },
      { ...base, payTo: SPONSOR },
      { ...base, provider: 11n },
      { ...base, invoiceId: new Uint8Array(16).fill(7) },
    ];
    for (const variant of variants) {
      assert.notDeepEqual(invoiceHash(variant), invoiceHash(base));
    }
    // Length prefixes: moving digits between amount and provider changes the hash.
    const shifted = { ...base, amount: 11n, provider: 0n };
    const unshifted = { ...base, amount: 1n, provider: 10n };
    assert.notDeepEqual(invoiceHash(shifted), invoiceHash(unshifted));
  });

  test("malformed offers are refused", () => {
    const good = offer();
    const bad: PaymentRequirements[] = [
      { ...good, scheme: "exact" },
      { ...good, network: "eip155:1" },
      { ...good, asset: "EURR" },
      { ...good, amount: "0" },
      { ...good, amount: "1.5" },
      { ...good, maxTimeoutSeconds: 61 },
      { ...good, payTo: "not-an-address" },
      { ...good, extra: { ...good.extra, invoiceId: "xyz" } },
      { ...good, extra: { ...good.extra, provider: "-1" } },
      { ...good, extra: { ...good.extra, feePayer: 42 } },
    ];
    for (const requirements of bad) {
      assert.throws(() => parseRequirements(requirements), RequirementsError, JSON.stringify(requirements));
    }
  });
});
