import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET } from "@claw-pay-concordium/x402-vault";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import { InvoiceBook } from "./invoice-book.ts";

const OFFER = {
  network: CONCORDIUM_TESTNET,
  payTo: AccountAddress.toBase58(addressOf(0x03)),
  feePayer: AccountAddress.toBase58(addressOf(0x09)),
  provider: 10n,
};

function book(options: { ttlMs?: number; maxOutstanding?: number } = {}): { book: InvoiceBook; clock: { now: number } } {
  const clock = { now: 1_795_350_000_000 };
  return { book: new InvoiceBook({ offer: OFFER, now: () => clock.now, ...options }), clock };
}

/** The payload as it arrives over HTTP: `accepted` went through JSON. */
function payloadFor(requirements: PaymentRequirements, patch: Partial<PaymentRequirements> = {}): PaymentPayload {
  return { x402Version: 2, accepted: JSON.parse(JSON.stringify({ ...requirements, ...patch })) as PaymentRequirements, payload: {} };
}

describe("InvoiceBook", () => {
  test("issues a fresh invoice per answer and honours it once", () => {
    const { book: b } = book();
    const a = b.issue("/weather", 1_000_000n);
    const c = b.issue("/weather", 1_000_000n);
    assert.notEqual(a.extra["invoiceId"], c.extra["invoiceId"]);
    assert.equal(a.amount, "1000000");
    const first = b.redeem(payloadFor(a), "/weather");
    assert.ok(first.ok);
    assert.equal(first.requirements, a);
    assert.deepEqual(b.redeem(payloadFor(a), "/weather"), { ok: false, reason: "invoice_used" });
  });

  test("an invoice is marked used before settling, so a concurrent second use fails", () => {
    const { book: b } = book();
    const a = b.issue("/weather", 1n);
    const results = [b.redeem(payloadFor(a), "/weather"), b.redeem(payloadFor(a), "/weather")];
    assert.deepEqual(results.map((r) => r.ok), [true, false]);
  });

  test("unknown invoices are refused", () => {
    const { book: b } = book();
    const a = b.issue("/weather", 1n);
    assert.deepEqual(b.redeem(payloadFor(a, { extra: { ...a.extra, invoiceId: "00".repeat(16) } }), "/weather"), { ok: false, reason: "unknown_invoice" });
    assert.deepEqual(b.redeem(payloadFor(a, { extra: { ...a.extra, invoiceId: 7 } }), "/weather"), { ok: false, reason: "unknown_invoice" });
  });

  test("an invoice is honoured only for the resource it was issued for, and is not burned by a wrong path", () => {
    const { book: b } = book();
    const a = b.issue("/weather", 1n);
    assert.deepEqual(b.redeem(payloadFor(a), "/news"), { ok: false, reason: "wrong_resource" });
    assert.ok(b.redeem(payloadFor(a), "/weather").ok);
  });

  test("an offer changed by the client is refused", () => {
    const { book: b } = book();
    const a = b.issue("/weather", 1_000_000n);
    assert.deepEqual(b.redeem(payloadFor(a, { amount: "1" }), "/weather"), { ok: false, reason: "offer_changed" });
    assert.deepEqual(b.redeem(payloadFor(a, { payTo: AccountAddress.toBase58(addressOf(0x05)) }), "/weather"), { ok: false, reason: "offer_changed" });
    assert.ok(b.redeem(payloadFor(a), "/weather").ok);
  });

  test("invoices expire", () => {
    const { book: b, clock } = book({ ttlMs: 60_000 });
    const a = b.issue("/weather", 1n);
    clock.now += 60_001;
    assert.deepEqual(b.redeem(payloadFor(a), "/weather"), { ok: false, reason: "invoice_expired" });
  });

  test("the book is bounded: expired first, then the oldest goes", () => {
    const { book: b, clock } = book({ ttlMs: 60_000, maxOutstanding: 3 });
    const first = b.issue("/a", 1n);
    b.issue("/a", 1n);
    b.issue("/a", 1n);
    b.issue("/a", 1n);
    assert.equal(b.size, 3);
    assert.deepEqual(b.redeem(payloadFor(first), "/a"), { ok: false, reason: "unknown_invoice" });
    clock.now += 60_001;
    b.issue("/a", 1n);
    assert.equal(b.size, 1, "expired invoices are pruned on the next issue");
  });
});
