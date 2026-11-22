/**
 * The agent's local receipt log: append-only JSON lines, each hash-linked to
 * the one before, re-verified in full every time the log is opened.
 *
 * It records every payment the client starts (`attempt`) and how it ended
 * (`settled` or `failed`), so spend-policy can total the day and replay-guard
 * can refuse reused invoices. It is a second layer and a convenience: the
 * vault's on-chain receipts are the source of truth (checked with
 * `claw-pay-verify`). Reconciling this log against the chain comes in PR 5b.
 */

import { createHash } from "node:crypto";
import { closeSync, existsSync, fsyncSync, openSync, readFileSync, statSync, writeSync } from "node:fs";

import type { InvalidReason } from "@claw-pay-concordium/x402-vault";

export type EntryKind = "attempt" | "settled" | "failed";

/** What a payment is, as the client saw it when it signed. */
export interface PaymentRecord {
  url: string;
  provider: bigint;
  payTo: string;
  amount: bigint;
  /** Lowercase hex, 32 bytes. */
  invoiceHash: string;
  vaultNonce: bigint;
}

export interface LogEntry {
  seq: number;
  prevHash: string;
  /** ISO 8601, UTC. */
  at: string;
  kind: EntryKind;
  url: string;
  provider: string;
  payTo: string;
  amount: string;
  invoiceHash: string;
  vaultNonce: string;
  transaction?: string;
  errorReason?: string;
  hash: string;
}

export interface Outcome {
  transaction?: string;
  errorReason?: string;
}

/** Thrown when the log fails verification or cannot be used. */
export class ReceiptLogError extends Error {
  override name = "ReceiptLogError";
}

export const GENESIS_HASH = "0".repeat(64);
const DAY_MILLIS = 86_400_000;

/**
 * Settle failures after which, by the seller's report, no CCD moved: the
 * facilitator refused before submitting, or the vault rejected on chain.
 * Any other failure, and any attempt without an outcome, still counts as
 * spent, because the payment may have landed.
 */
const NOTHING_MOVED: ReadonlySet<string> = new Set([
  "invalid_requirements",
  "unsupported_network",
  "sponsor_mismatch",
  "invalid_transaction_format",
  "invalid_transaction_version",
  "not_a_contract_update",
  "nonzero_amount",
  "vault_not_allowed",
  "wrong_entrypoint",
  "energy_too_high",
  "invalid_pay_params",
  "provider_mismatch",
  "amount_mismatch",
  "invoice_mismatch",
  "sender_is_sponsor",
  "expired",
  "expiry_too_far",
  "invalid_sender_signature",
  "sender_not_agent",
  "dry_run_rejected",
  "dry_run_receipt_mismatch",
  "payment_in_flight",
  "transaction_rejected",
] satisfies (InvalidReason | "transaction_rejected")[]);

const FIELDS = [
  "seq",
  "prevHash",
  "at",
  "kind",
  "url",
  "provider",
  "payTo",
  "amount",
  "invoiceHash",
  "vaultNonce",
  "transaction",
  "errorReason",
] as const;

/** The entry's fields in a fixed order, absent optional fields left out. */
function ordered(entry: Omit<LogEntry, "hash">): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of FIELDS) {
    const value = entry[field];
    if (value !== undefined) {
      out[field] = value;
    }
  }
  return out;
}

/** SHA-256 of the canonical JSON: the fixed-order fields without `hash`. */
function hashOf(entry: Omit<LogEntry, "hash">): string {
  return createHash("sha256").update(JSON.stringify(ordered(entry)), "utf8").digest("hex");
}

const HEX32 = /^[0-9a-f]{64}$/;
const DECIMAL = /^(0|[1-9][0-9]*)$/;

function parseLine(line: string, n: number): LogEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new ReceiptLogError(`line ${String(n)} is not JSON`);
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new ReceiptLogError(`line ${String(n)} is not an object`);
  }
  const raw = value as Record<string, unknown>;
  const allowed = new Set<string>([...FIELDS, "hash"]);
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      throw new ReceiptLogError(`line ${String(n)} has an unknown field "${key}"`);
    }
  }
  const str = (key: string, pattern?: RegExp): string => {
    const field = raw[key];
    if (typeof field !== "string" || (pattern !== undefined && !pattern.test(field))) {
      throw new ReceiptLogError(`line ${String(n)}: bad "${key}"`);
    }
    return field;
  };
  const optional = (key: string): string | undefined => (raw[key] === undefined ? undefined : str(key));
  const seq = raw["seq"];
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0) {
    throw new ReceiptLogError(`line ${String(n)}: bad "seq"`);
  }
  const kind = str("kind");
  if (kind !== "attempt" && kind !== "settled" && kind !== "failed") {
    throw new ReceiptLogError(`line ${String(n)}: bad "kind"`);
  }
  const entry: LogEntry = {
    seq,
    prevHash: str("prevHash", HEX32),
    at: str("at"),
    kind,
    url: str("url"),
    provider: str("provider", DECIMAL),
    payTo: str("payTo"),
    amount: str("amount", DECIMAL),
    invoiceHash: str("invoiceHash", HEX32),
    vaultNonce: str("vaultNonce", DECIMAL),
    hash: str("hash", HEX32),
  };
  const transaction = optional("transaction");
  if (transaction !== undefined) {
    entry.transaction = transaction;
  }
  const errorReason = optional("errorReason");
  if (errorReason !== undefined) {
    entry.errorReason = errorReason;
  }
  if (Number.isNaN(Date.parse(entry.at))) {
    throw new ReceiptLogError(`line ${String(n)}: bad "at"`);
  }
  return entry;
}

/** Where the log's lines live. */
export interface LogStore {
  read(): string;
  append(line: string): void;
}

/** An in-memory store, for tests. */
export class MemoryLogStore implements LogStore {
  text = "";

  read(): string {
    return this.text;
  }

  append(line: string): void {
    this.text += `${line}\n`;
  }
}

/**
 * A file store. The file is created with mode 600 and each line is synced to
 * disk. An existing file that group or others can write is refused.
 */
export function fileLogStore(path: string): LogStore {
  if (existsSync(path)) {
    const stats = statSync(path);
    if (!stats.isFile()) {
      throw new ReceiptLogError("the receipt log path is not a regular file");
    }
    if ((stats.mode & 0o022) !== 0) {
      throw new ReceiptLogError("the receipt log is writable by group or others; chmod 600 it");
    }
  }
  return {
    read: () => (existsSync(path) ? readFileSync(path, "utf8") : ""),
    append: (line) => {
      const fd = openSync(path, "a", 0o600);
      try {
        writeSync(fd, `${line}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
    },
  };
}

export class ReceiptLog {
  readonly #store: LogStore;
  readonly #entries: LogEntry[];

  private constructor(store: LogStore, entries: LogEntry[]) {
    this.#store = store;
    this.#entries = entries;
  }

  /**
   * Open and verify a log: every line must parse, hash to its `hash`, follow
   * on from the previous line's hash and carry the next `seq`. An edited,
   * reordered or mid-truncated log is refused. (Dropping lines from the end
   * cannot be seen locally; the chain is the check for that.)
   */
  static open(store: LogStore): ReceiptLog {
    const text = store.read();
    const entries: LogEntry[] = [];
    if (text !== "") {
      if (!text.endsWith("\n")) {
        throw new ReceiptLogError("the last line is incomplete (interrupted write?)");
      }
      const lines = text.slice(0, -1).split("\n");
      let prevHash = GENESIS_HASH;
      for (const [i, line] of lines.entries()) {
        const entry = parseLine(line, i + 1);
        const { hash, ...body } = entry;
        if (entry.seq !== i) {
          throw new ReceiptLogError(`line ${String(i + 1)}: expected seq ${String(i)}`);
        }
        if (entry.prevHash !== prevHash) {
          throw new ReceiptLogError(`line ${String(i + 1)}: does not follow the previous line`);
        }
        if (hashOf(body) !== hash) {
          throw new ReceiptLogError(`line ${String(i + 1)}: hash mismatch (edited?)`);
        }
        entries.push(entry);
        prevHash = hash;
      }
    }
    return new ReceiptLog(store, entries);
  }

  get entries(): readonly LogEntry[] {
    return this.#entries;
  }

  append(kind: EntryKind, record: PaymentRecord, outcome: Outcome = {}, at: Date = new Date()): LogEntry {
    const last = this.#entries.at(-1);
    const body: Omit<LogEntry, "hash"> = {
      seq: this.#entries.length,
      prevHash: last === undefined ? GENESIS_HASH : last.hash,
      at: at.toISOString(),
      kind,
      url: record.url,
      provider: String(record.provider),
      payTo: record.payTo,
      amount: String(record.amount),
      invoiceHash: record.invoiceHash,
      vaultNonce: String(record.vaultNonce),
    };
    if (outcome.transaction !== undefined) {
      body.transaction = outcome.transaction;
    }
    if (outcome.errorReason !== undefined) {
      body.errorReason = outcome.errorReason;
    }
    const entry: LogEntry = { ...body, hash: hashOf(body) };
    this.#store.append(JSON.stringify({ ...ordered(body), hash: entry.hash }));
    this.#entries.push(entry);
    return entry;
  }

  /** Whether any entry mentions this invoice hash. */
  attempted(invoiceHash: string): boolean {
    return this.#entries.some((entry) => entry.invoiceHash === invoiceHash);
  }

  /** The highest vault nonce of a settled payment, or null. */
  highestSettledNonce(): bigint | null {
    let highest: bigint | null = null;
    for (const entry of this.#entries) {
      const nonce = BigInt(entry.vaultNonce);
      if (entry.kind === "settled" && (highest === null || nonce > highest)) {
        highest = nonce;
      }
    }
    return highest;
  }

  /**
   * Micro-CCD counted as spent in UTC day `day` (epoch milliseconds ÷ 86 400 000,
   * the vault's window), by the time of each attempt. Settled payments count,
   * and so does any attempt that has no outcome or failed in a way that may
   * still have moved CCD.
   */
  spentInUtcDay(day: number): bigint {
    const byInvoice = new Map<string, { attempt?: LogEntry; outcome?: LogEntry }>();
    for (const entry of this.#entries) {
      const slot = byInvoice.get(entry.invoiceHash) ?? {};
      if (entry.kind === "attempt") {
        slot.attempt ??= entry;
      } else {
        slot.outcome = entry;
      }
      byInvoice.set(entry.invoiceHash, slot);
    }
    let total = 0n;
    for (const { attempt, outcome } of byInvoice.values()) {
      if (attempt === undefined || Math.floor(Date.parse(attempt.at) / DAY_MILLIS) !== day) {
        continue;
      }
      const nothingMoved =
        outcome?.kind === "failed" && outcome.errorReason !== undefined && NOTHING_MOVED.has(outcome.errorReason);
      if (!nothingMoved) {
        total += BigInt(attempt.amount);
      }
    }
    return total;
  }
}

/** The vault's UTC day index for a time in milliseconds. */
export function utcDay(nowMs: number): number {
  return Math.floor(nowMs / DAY_MILLIS);
}
