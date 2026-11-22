import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress } from "@concordium/web-sdk";
import { MemoryLogStore, ReceiptLog, type PaymentRecord } from "@claw-pay-concordium/agent-client";
import { decodeEvent, parseEventsFile, toHex, type ReceiptBody } from "@claw-pay-concordium/verifier";

import { goldenEventsJson } from "./fake-node.ts";
import { needsAttention, reconcile } from "./reconcile.ts";

const file = parseEventsFile(goldenEventsJson());
const receipts: ReceiptBody[] = file.events.flatMap((raw) => {
  const event = decodeEvent(raw);
  return event.kind === "Receipt" ? [event.body] : [];
});

function recordFor(body: ReceiptBody, overrides: Partial<PaymentRecord> = {}): PaymentRecord {
  const copy = new Uint8Array(32);
  copy.set(body.payee);
  return {
    url: "https://seller.example/",
    provider: body.provider,
    payTo: AccountAddress.toBase58(AccountAddress.fromBuffer(copy.buffer)),
    amount: body.amount,
    invoiceHash: toHex(body.invoiceHash),
    vaultNonce: body.nonce,
    ...overrides,
  };
}

function receipt(i: number): ReceiptBody {
  const body = receipts[i];
  assert.ok(body !== undefined);
  return body;
}

describe("reconcile", () => {
  test("the golden events hold four receipts", () => {
    assert.equal(receipts.length, 4);
  });

  test("sorts every case", () => {
    const log = ReceiptLog.open(new MemoryLogStore());
    // 0: settled, matches: confirmed.
    log.append("attempt", recordFor(receipt(0)));
    log.append("settled", recordFor(receipt(0)), { transaction: "aa".repeat(32) });
    // 1: failed locally, but it landed.
    log.append("attempt", recordFor(receipt(1)));
    log.append("failed", recordFor(receipt(1)), { errorReason: "finalization_timeout" });
    // 2: settled, but the log has another amount.
    const wrong = recordFor(receipt(2), { amount: 1n });
    log.append("attempt", wrong);
    log.append("settled", wrong, { transaction: "bb".repeat(32) });
    // 3: not in the log at all.
    // Settled locally, nothing on chain.
    const ghost = recordFor(receipt(0), { invoiceHash: "ee".repeat(32) });
    log.append("attempt", ghost);
    log.append("settled", ghost, { transaction: "cc".repeat(32) });
    // Failed locally, nothing on chain: fine, not reported.
    const refused = recordFor(receipt(0), { invoiceHash: "ff".repeat(32) });
    log.append("attempt", refused);
    log.append("failed", refused, { errorReason: "dry_run_rejected" });

    const report = reconcile(log.entries, file);
    assert.deepEqual(report.confirmed.map((item) => item.invoiceHash), [toHex(receipt(0).invoiceHash)]);
    assert.deepEqual(report.landedDespiteFailure.map((item) => [item.invoiceHash, item.local, item.errorReason]), [
      [toHex(receipt(1).invoiceHash), "failed", "finalization_timeout"],
    ]);
    assert.deepEqual(report.mismatched.map((item) => [item.invoiceHash, item.fields]), [[toHex(receipt(2).invoiceHash), ["amount"]]]);
    assert.deepEqual(report.notInLog.map((item) => item.invoiceHash), [toHex(receipt(3).invoiceHash)]);
    assert.deepEqual(report.missingOnChain, [{ invoiceHash: "ee".repeat(32), amount: receipt(0).amount, transaction: "cc".repeat(32) }]);
    assert.equal(needsAttention(report), true);
  });

  test("a payee or provider mismatch is reported", () => {
    const log = ReceiptLog.open(new MemoryLogStore());
    const other = AccountAddress.toBase58(AccountAddress.fromBuffer(new Uint8Array(32).fill(7).buffer));
    const bad = recordFor(receipt(0), { payTo: other, provider: 999n });
    log.append("attempt", bad);
    log.append("settled", bad);
    assert.deepEqual(reconcile(log.entries, file).mismatched[0]?.fields, ["provider", "payee"]);
  });

  test("a log that matches the chain needs no attention", () => {
    const log = ReceiptLog.open(new MemoryLogStore());
    for (const body of receipts) {
      log.append("attempt", recordFor(body));
      log.append("settled", recordFor(body));
    }
    const report = reconcile(log.entries, file);
    assert.equal(report.confirmed.length, 4);
    assert.equal(needsAttention(report), false);
  });
});
