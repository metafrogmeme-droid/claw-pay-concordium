import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { concatBytes, u64Bytes } from "./bytes.ts";
import { EventsFileError, parseEventsFile, type EventsFile } from "./events-file.ts";
import {
  decodeEvent,
  encodeReceiptBody,
  encodeReceiptEvent,
  type ReceiptBody,
} from "./events.ts";
import { verify, type IssueCode, type Report } from "./verify.ts";

/** The golden file written by the Rust tests on the simulated chain. */
const FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/vault-events.v1.json", import.meta.url),
);
const FIXTURE_JSON = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as unknown;

/** A fresh copy of the golden events file. */
function golden(): EventsFile {
  return parseEventsFile(FIXTURE_JSON);
}

function codes(report: Report): IssueCode[] {
  return [...new Set(report.issues.map((issue) => issue.code))].sort();
}

/** Indexes of the receipt events (tag 8) in the file. */
function receiptIndexes(file: EventsFile): number[] {
  return file.events.flatMap((event, i) => (event[0] === 8 ? [i] : []));
}

function at<T>(items: readonly T[], i: number): T {
  const item = items[i];
  if (item === undefined) {
    throw new Error(`no item at ${String(i)}`);
  }
  return item;
}

function lastReceiptBody(file: EventsFile): ReceiptBody {
  const event = decodeEvent(at(file.events, at(receiptIndexes(file), 3)));
  if (event.kind !== "Receipt") {
    throw new Error("expected a receipt");
  }
  return event.body;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

/**
 * Append a receipt that is consistent with the chain (right nonce, link and
 * hash, and the view moved to it) but changed by `change`, the way a forger
 * with no access to the contract would have to build it.
 */
function appendForged(file: EventsFile, change: (body: ReceiptBody) => void): void {
  const last = lastReceiptBody(file);
  const body: ReceiptBody = {
    ...last,
    nonce: last.nonce + 1n,
    prevHash: file.view.receiptHead,
    timestamp: last.timestamp + 1_000n,
    amount: 1_000_000n,
    invoiceHash: new Uint8Array(32).fill(0x99),
  };
  change(body);
  const bodyBytes = encodeReceiptBody(body);
  const hash = sha256(bodyBytes);
  file.events.push(encodeReceiptEvent(bodyBytes, hash));
  file.view = { nextNonce: body.nonce + 1n, receiptHead: hash };
}

describe("golden fixture from the contract", () => {
  test("verifies: intact chain, rules respected, head matches", () => {
    const report = verify(golden());
    assert.deepEqual(report.issues, []);
    assert.equal(report.ok, true);
    assert.equal(report.receipts.length, 4);
  });

  test("decodes the payments the Rust scenario made", () => {
    const { receipts } = verify(golden());
    assert.deepEqual(
      receipts.map((r) => [r.body.nonce, r.body.provider, r.body.amount]),
      [
        [0n, 1n, 3_000_000n],
        [1n, 1n, 5_000_000n],
        [2n, 2n, 4_000_000n],
        [3n, 2n, 2_000_000n],
      ],
    );
    const payees = receipts.map((r) => at([...r.body.payee], 0));
    assert.deepEqual(payees, [3, 3, 6, 6], "agent 1 pays PROVIDER, agent 2 pays NEW_WALLET");
    assert.deepEqual(at(receipts, 0).body.prevHash, new Uint8Array(32));
  });
});

describe("tampered files fail", () => {
  test("a changed body byte breaks the hash", () => {
    const file = golden();
    const i = at(receiptIndexes(file), 0);
    const event = at(file.events, i).slice();
    event[1 + 200] = (at([...event], 1 + 200) + 1) % 256; // inside invoice_hash
    file.events[i] = event;
    assert.deepEqual(codes(verify(file)), ["hash-mismatch"]);
  });

  test("a dropped receipt breaks the link, the sequence and the count", () => {
    const file = golden();
    file.events.splice(at(receiptIndexes(file), 1), 1);
    assert.deepEqual(codes(verify(file)), ["count-mismatch", "link-broken", "nonce-gap"]);
  });

  test("swapped receipts break the sequence and the links", () => {
    const file = golden();
    const [a, b] = [at(receiptIndexes(file), 0), at(receiptIndexes(file), 1)];
    [file.events[a], file.events[b]] = [at(file.events, b), at(file.events, a)];
    const found = codes(verify(file));
    assert.ok(found.includes("nonce-gap"), found.join());
    assert.ok(found.includes("link-broken"), found.join());
  });

  test("a truncated chain no longer reaches the contract's head", () => {
    const file = golden();
    file.events.splice(at(receiptIndexes(file), 3), 1);
    assert.deepEqual(codes(verify(file)), ["count-mismatch", "head-mismatch"]);
  });

  test("receipts from another vault are refused", () => {
    const file = golden();
    file.vault = { index: 99n, subindex: 0n };
    assert.deepEqual(codes(verify(file)), ["vault-mismatch"]);
  });

  test("a forged receipt above the caps is caught by the rule replay", () => {
    const file = golden();
    appendForged(file, (body) => {
      body.amount = 50_000_000n;
    });
    assert.deepEqual(codes(verify(file)), ["daily-cap", "per-tx-cap"]);
  });

  test("a forged receipt reusing an invoice is caught", () => {
    const file = golden();
    const first = decodeEvent(at(file.events, at(receiptIndexes(file), 0)));
    appendForged(file, (body) => {
      if (first.kind === "Receipt") {
        body.invoiceHash = first.body.invoiceHash;
      }
    });
    assert.deepEqual(codes(verify(file)), ["invoice-reused"]);
  });

  test("a forged receipt from another account is caught", () => {
    const file = golden();
    appendForged(file, (body) => {
      body.agent = new Uint8Array(32).fill(0x55);
    });
    assert.deepEqual(codes(verify(file)), ["agent-mismatch"]);
  });

  test("a receipt while paused is caught", () => {
    const file = golden();
    file.events.splice(at(receiptIndexes(file), 3), 0, new Uint8Array([5, 1]));
    assert.deepEqual(codes(verify(file)), ["paused"]);
  });

  test("a receipt to a removed provider is caught", () => {
    const file = golden();
    const removeAgent2 = concatBytes([new Uint8Array([7]), u64Bytes(2n)]);
    file.events.splice(at(receiptIndexes(file), 3), 0, removeAgent2);
    assert.deepEqual(codes(verify(file)), ["provider-not-allowed"]);
  });

  test("an undecodable event is reported", () => {
    const file = golden();
    file.events[1] = new Uint8Array([42]);
    assert.deepEqual(codes(verify(file)), ["decode-error"]);
  });

  test("without Initialized the rules cannot be replayed", () => {
    const file = golden();
    file.events.shift();
    assert.deepEqual(codes(verify(file)), ["missing-initialized"]);
  });
});

describe("parseEventsFile", () => {
  test("rejects files of the wrong shape", () => {
    const bad: unknown[] = [
      null,
      { format: "something-else" },
      { ...(FIXTURE_JSON as object), events: "nope" },
      { ...(FIXTURE_JSON as object), events: ["0g"] },
      { ...(FIXTURE_JSON as object), view: { next_nonce: 4, receipt_head: "00" } },
      { ...(FIXTURE_JSON as object), vault: { index: -1, subindex: 0 } },
    ];
    for (const json of bad) {
      assert.throws(() => parseEventsFile(json), EventsFileError, JSON.stringify(json));
    }
  });
});
