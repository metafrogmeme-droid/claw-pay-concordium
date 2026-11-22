import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { MemoryLogStore, ReceiptLog, type PaymentRecord } from "./receipt-log.ts";
import { ReplayGuard } from "./replay-guard.ts";

const INVOICE_A = "aa".repeat(32);
const INVOICE_B = "bb".repeat(32);

function record(invoiceHash: string, vaultNonce: bigint): PaymentRecord {
  return { url: "https://seller.example/", provider: 10n, payTo: "x", amount: 1n, invoiceHash, vaultNonce };
}

function guardWith(setup: (log: ReceiptLog) => void = () => undefined): ReplayGuard {
  const log = ReceiptLog.open(new MemoryLogStore());
  setup(log);
  return new ReplayGuard(log);
}

describe("replay-guard", () => {
  test("a new invoice with a fresh nonce may start", () => {
    const acquired = guardWith().acquire(INVOICE_A, 0n);
    assert.ok(acquired.ok);
  });

  test("an invoice already attempted is refused, whatever its outcome", () => {
    const guard = guardWith((log) => {
      log.append("attempt", record(INVOICE_A, 0n));
      log.append("failed", record(INVOICE_A, 0n), { errorReason: "transaction_rejected" });
    });
    assert.deepEqual(guard.check(INVOICE_A, 1n), ["invoice_already_attempted"]);
  });

  test("a nonce at or below the highest settled nonce is stale", () => {
    const guard = guardWith((log) => {
      log.append("attempt", record(INVOICE_A, 4n));
      log.append("settled", record(INVOICE_A, 4n), { transaction: "cd".repeat(32) });
    });
    assert.deepEqual(guard.check(INVOICE_B, 4n), ["stale_nonce"]);
    assert.deepEqual(guard.check(INVOICE_B, 3n), ["stale_nonce"]);
    assert.deepEqual(guard.check(INVOICE_B, 5n), []);
  });

  test("one payment in flight at a time; release is idempotent", () => {
    const guard = guardWith();
    const first = guard.acquire(INVOICE_A, 0n);
    assert.ok(first.ok);
    assert.deepEqual(guard.acquire(INVOICE_B, 1n), { ok: false, reasons: ["payment_in_flight"] });
    first.release();
    first.release();
    const second = guard.acquire(INVOICE_B, 1n);
    assert.ok(second.ok);
    assert.deepEqual(guard.check(INVOICE_A, 2n), ["payment_in_flight"]);
  });
});
