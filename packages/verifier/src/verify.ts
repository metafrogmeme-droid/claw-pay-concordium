/**
 * Rebuild and check the GuardVault receipt chain from its events alone.
 *
 * Integrity: each receipt's hash is the SHA-256 of its body bytes exactly as
 * logged, nonces run 0, 1, 2, …, and each `prev_hash` is the previous hash.
 * The chain must end at the head the contract reports.
 *
 * Rules: owner events (`Initialized`, `CapsSet`, `AgentSet`, `PausedSet`,
 * `ProviderAdded`, `ProviderRemoved`) are replayed in order, and every
 * receipt is checked against the rules in force at that point, the same way
 * the contract checks a payment.
 */

import { createHash } from "node:crypto";

import { DecodeError, equalBytes, toHex } from "./bytes.ts";
import type { EventsFile } from "./events-file.ts";
import { HASH_LENGTH, decodeEvent, type ReceiptBody } from "./events.ts";

/** Milliseconds in one day: the vault's daily window is a fixed UTC day. */
export const DAY_MILLIS = 86_400_000n;

export type IssueCode =
  | "decode-error"
  | "missing-initialized"
  | "unexpected-initialized"
  | "hash-mismatch"
  | "vault-mismatch"
  | "nonce-gap"
  | "link-broken"
  | "time-backwards"
  | "agent-mismatch"
  | "paused"
  | "provider-not-allowed"
  | "card-hash-mismatch"
  | "zero-amount"
  | "per-tx-cap"
  | "daily-cap"
  | "invoice-reused"
  | "head-mismatch"
  | "count-mismatch";

export interface Issue {
  code: IssueCode;
  /** Index into the events array, or null for whole-file issues. */
  event: number | null;
  message: string;
}

export interface CheckedReceipt {
  event: number;
  body: ReceiptBody;
  hash: Uint8Array;
}

export interface Report {
  ok: boolean;
  receipts: CheckedReceipt[];
  issues: Issue[];
}

interface Rules {
  agent: Uint8Array;
  perTxCap: bigint;
  dailyCap: bigint;
  paused: boolean;
  /** Allowlist: registry token id to approved card hash. */
  providers: Map<bigint, Uint8Array>;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function verify(file: EventsFile): Report {
  const issues: Issue[] = [];
  const receipts: CheckedReceipt[] = [];
  const report = (code: IssueCode, event: number | null, message: string): void => {
    issues.push({ code, event, message });
  };

  let rules: Rules | null = null;
  let expectedNonce = 0n;
  let prevHash: Uint8Array = new Uint8Array(HASH_LENGTH);
  let lastTimestamp: bigint | null = null;
  // Daily total, exactly as the contract keeps it.
  let day: bigint | null = null;
  let spentToday = 0n;
  const invoices = new Set<string>();

  for (const [index, raw] of file.events.entries()) {
    let event;
    try {
      event = decodeEvent(raw);
    } catch (error) {
      if (error instanceof DecodeError) {
        report("decode-error", index, error.message);
        continue;
      }
      throw error;
    }

    switch (event.kind) {
      case "Initialized":
        if (index !== 0 || rules !== null) {
          report("unexpected-initialized", index, "Initialized must be the first event");
          break;
        }
        rules = {
          agent: event.agent,
          perTxCap: event.perTxCap,
          dailyCap: event.dailyCap,
          paused: false,
          providers: new Map(),
        };
        break;
      case "CapsSet":
        if (rules) {
          rules.perTxCap = event.perTxCap;
          rules.dailyCap = event.dailyCap;
        }
        break;
      case "AgentSet":
        if (rules) {
          rules.agent = event.agent;
        }
        break;
      case "PausedSet":
        if (rules) {
          rules.paused = event.paused;
        }
        break;
      case "ProviderAdded":
        rules?.providers.set(event.tokenId, event.cardHash);
        break;
      case "ProviderRemoved":
        rules?.providers.delete(event.tokenId);
        break;
      case "Deposited":
      case "Withdrawn":
        break;
      case "Receipt": {
        const { body, bodyBytes, hash } = event;

        // Integrity.
        if (!equalBytes(sha256(bodyBytes), hash)) {
          report("hash-mismatch", index, "hash is not the SHA-256 of the receipt body");
        }
        if (body.vault.index !== file.vault.index || body.vault.subindex !== file.vault.subindex) {
          report("vault-mismatch", index, "receipt names a different vault");
        }
        if (body.nonce !== expectedNonce) {
          report(
            "nonce-gap",
            index,
            `expected nonce ${String(expectedNonce)}, found ${String(body.nonce)}`,
          );
        }
        if (!equalBytes(body.prevHash, prevHash)) {
          report("link-broken", index, "prev_hash is not the previous receipt's hash");
        }
        if (lastTimestamp !== null && body.timestamp < lastTimestamp) {
          report("time-backwards", index, "timestamp is earlier than the previous receipt");
        }

        // Rules in force at this point.
        const today = body.timestamp / DAY_MILLIS;
        const spentBefore = day === null || today > day ? 0n : spentToday;
        const total = spentBefore + body.amount;
        if (rules) {
          if (!equalBytes(body.agent, rules.agent)) {
            report("agent-mismatch", index, "paid by an account that was not the agent");
          }
          if (rules.paused) {
            report("paused", index, "paid while the vault was paused");
          }
          const card = rules.providers.get(body.provider);
          if (card === undefined) {
            report(
              "provider-not-allowed",
              index,
              `provider ${String(body.provider)} was not on the allowlist`,
            );
          } else if (!equalBytes(card, body.cardHash)) {
            report("card-hash-mismatch", index, "card hash differs from the approved one");
          }
          if (body.amount === 0n) {
            report("zero-amount", index, "amount is zero");
          } else if (body.amount > rules.perTxCap) {
            report("per-tx-cap", index, "amount is above the per-payment cap");
          }
          if (total > rules.dailyCap) {
            report("daily-cap", index, "today's total is above the daily cap");
          }
        }
        const invoice = toHex(body.invoiceHash);
        if (invoices.has(invoice)) {
          report("invoice-reused", index, "invoice hash was already paid");
        }

        // Advance as the contract did when it logged this receipt.
        invoices.add(invoice);
        day = day === null || today > day ? today : day;
        spentToday = total;
        expectedNonce = body.nonce + 1n;
        prevHash = hash;
        lastTimestamp = body.timestamp;
        receipts.push({ event: index, body, hash });
        break;
      }
    }
  }

  if (rules === null) {
    report(
      "missing-initialized",
      null,
      "no Initialized event first, so caps, pause, agent and allowlist were not replayed",
    );
  }
  if (!equalBytes(prevHash, file.view.receiptHead)) {
    report("head-mismatch", null, "the chain does not end at the head the contract reports");
  }
  if (BigInt(receipts.length) !== file.view.nextNonce) {
    report(
      "count-mismatch",
      null,
      `found ${String(receipts.length)} receipts, the contract reports ${String(file.view.nextNonce)}`,
    );
  }

  return { ok: issues.length === 0, receipts, issues };
}
