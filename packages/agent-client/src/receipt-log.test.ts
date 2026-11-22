import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import {
  GENESIS_HASH,
  MemoryLogStore,
  ReceiptLog,
  ReceiptLogError,
  fileLogStore,
  utcDay,
  type PaymentRecord,
} from "./receipt-log.ts";

function record(invoiceByte: number, overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  return {
    url: "https://seller.example/weather",
    provider: 10n,
    payTo: "3kBx2h5Y2veb4hZgAJWPrr8RyQESKm5TjzF3ti1QQ4VSYLwK1G",
    amount: 1_000_000n,
    invoiceHash: invoiceByte.toString(16).padStart(2, "0").repeat(32),
    vaultNonce: BigInt(invoiceByte),
    ...overrides,
  };
}

const DAY = 20_779; // 2026-11-22 UTC
const AT = (offsetMs: number): Date => new Date(DAY * 86_400_000 + offsetMs);

function filled(): MemoryLogStore {
  const store = new MemoryLogStore();
  const log = ReceiptLog.open(store);
  log.append("attempt", record(1), {}, AT(1_000));
  log.append("settled", record(1), { transaction: "ab".repeat(32) }, AT(2_000));
  log.append("attempt", record(2), {}, AT(3_000));
  return store;
}

function lines(store: MemoryLogStore): string[] {
  return store.text.slice(0, -1).split("\n");
}

function withLines(next: string[]): MemoryLogStore {
  const store = new MemoryLogStore();
  store.text = `${next.join("\n")}\n`;
  return store;
}

describe("receipt log chain", () => {
  test("round-trips and links every entry to the one before", () => {
    const store = filled();
    const log = ReceiptLog.open(store);
    const [first, second, third, ...rest] = log.entries;
    assert.ok(first !== undefined && second !== undefined && third !== undefined);
    assert.equal(rest.length, 0);
    assert.equal(first.prevHash, GENESIS_HASH);
    assert.equal(second.prevHash, first.hash);
    assert.equal(third.prevHash, second.hash);
    assert.deepEqual(log.entries.map((entry) => entry.seq), [0, 1, 2]);
    assert.equal(second.transaction, "ab".repeat(32));
    const next = log.append("failed", record(2), { errorReason: "transaction_rejected" }, AT(4_000));
    assert.equal(next.prevHash, third.hash);
    assert.equal(ReceiptLog.open(store).entries.length, 4);
  });

  test("an empty log opens empty", () => {
    assert.equal(ReceiptLog.open(new MemoryLogStore()).entries.length, 0);
  });

  test("an edited line is refused", () => {
    const original = lines(filled());
    const edited = JSON.parse(original[0] ?? "") as Record<string, unknown>;
    edited["amount"] = "1";
    assert.throws(() => ReceiptLog.open(withLines([JSON.stringify(edited), ...original.slice(1)])), /hash mismatch/);
  });

  test("a dropped or reordered line is refused", () => {
    const original = lines(filled());
    const [a = "", b = "", c = ""] = original;
    assert.throws(() => ReceiptLog.open(withLines([a, c])), ReceiptLogError);
    assert.throws(() => ReceiptLog.open(withLines([b, a, c])), ReceiptLogError);
  });

  test("unknown fields, junk and an interrupted last line are refused", () => {
    const original = lines(filled());
    const extra = { ...(JSON.parse(original[0] ?? "") as Record<string, unknown>), note: "x" };
    assert.throws(() => ReceiptLog.open(withLines([JSON.stringify(extra)])), /unknown field/);
    assert.throws(() => ReceiptLog.open(withLines(["not json"])), /not JSON/);
    const store = new MemoryLogStore();
    store.text = original.join("\n");
    assert.throws(() => ReceiptLog.open(store), /incomplete/);
  });
});

describe("receipt log queries", () => {
  test("attempted and highestSettledNonce", () => {
    const log = ReceiptLog.open(filled());
    assert.equal(log.attempted(record(1).invoiceHash), true);
    assert.equal(log.attempted(record(9).invoiceHash), false);
    assert.equal(log.highestSettledNonce(), 1n);
    assert.equal(ReceiptLog.open(new MemoryLogStore()).highestSettledNonce(), null);
  });

  test("daily spend is conservative", () => {
    const log = ReceiptLog.open(new MemoryLogStore());
    // Settled: counts.
    log.append("attempt", record(1), {}, AT(0));
    log.append("settled", record(1), { transaction: "aa".repeat(32) }, AT(1));
    // No outcome yet: counts.
    log.append("attempt", record(2), {}, AT(2));
    // Rejected on chain: nothing moved.
    log.append("attempt", record(3), {}, AT(3));
    log.append("failed", record(3), { errorReason: "transaction_rejected" }, AT(4));
    // Refused by the facilitator before submitting: nothing moved.
    log.append("attempt", record(4), {}, AT(5));
    log.append("failed", record(4), { errorReason: "dry_run_rejected" }, AT(6));
    // Timed out: may still land, counts.
    log.append("attempt", record(5), {}, AT(7));
    log.append("failed", record(5), { errorReason: "finalization_timeout" }, AT(8));
    // Unknown failure: counts.
    log.append("attempt", record(6), {}, AT(9));
    log.append("failed", record(6), { errorReason: "no_settle_response" }, AT(10));
    assert.equal(log.spentInUtcDay(DAY), 4_000_000n);
  });

  test("the day is the vault's fixed UTC day", () => {
    const log = ReceiptLog.open(new MemoryLogStore());
    log.append("attempt", record(1), {}, AT(-1)); // 23:59:59.999 the day before
    log.append("attempt", record(2, { amount: 2n }), {}, AT(0)); // 00:00:00.000
    assert.equal(log.spentInUtcDay(DAY - 1), 1_000_000n);
    assert.equal(log.spentInUtcDay(DAY), 2n);
    assert.equal(utcDay(AT(0).getTime()), DAY);
    assert.equal(utcDay(AT(-1).getTime()), DAY - 1);
  });
});

describe("file store", () => {
  const dir = mkdtempSync(join(tmpdir(), "claw-pay-log-"));
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("creates the log with mode 600 and reopens it", () => {
    const path = join(dir, "receipts.jsonl");
    const log = ReceiptLog.open(fileLogStore(path));
    log.append("attempt", record(1), {}, AT(0));
    assert.equal(statSync(path).mode & 0o777, 0o600);
    assert.equal(ReceiptLog.open(fileLogStore(path)).entries.length, 1);
  });

  test("refuses a log that group or others can write", () => {
    const path = join(dir, "shared.jsonl");
    ReceiptLog.open(fileLogStore(path)).append("attempt", record(1), {}, AT(0));
    chmodSync(path, 0o664);
    assert.throws(() => fileLogStore(path), /writable by group or others/);
  });
});
