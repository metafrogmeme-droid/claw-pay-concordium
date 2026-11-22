/**
 * Checking the agent's local receipt log against the vault's on-chain
 * receipts. Read-only: it reports, and never edits the log.
 *
 * Matching is by invoice hash, which the vault accepts at most once.
 */

import { AccountAddress } from "@concordium/web-sdk";
import type { LogEntry } from "@claw-pay-concordium/agent-client";
import { decodeEvent, equalBytes, toHex, type EventsFile, type ReceiptBody } from "@claw-pay-concordium/verifier";

export interface ReconcileItem {
  invoiceHash: string;
  /** Micro-CCD. */
  amount: bigint;
}

export interface ReconcileReport {
  /** Settled locally, with a matching receipt on chain. */
  confirmed: (ReconcileItem & { nonce: bigint })[];
  /** Settled locally, but no receipt on chain (yet, or the seller misreported). */
  missingOnChain: (ReconcileItem & { transaction?: string })[];
  /** Failed or pending locally, but a receipt exists: the payment landed. */
  landedDespiteFailure: (ReconcileItem & { local: "failed" | "pending"; errorReason?: string; nonce: bigint })[];
  /** Settled locally and on chain, but the receipt disagrees with the log. */
  mismatched: (ReconcileItem & { fields: ("amount" | "provider" | "payee")[] })[];
  /** Receipts the log does not know. */
  notInLog: (ReconcileItem & { nonce: bigint })[];
}

function accountBytes(base58: string): Uint8Array | null {
  try {
    return AccountAddress.fromBase58(base58).decodedAddress;
  } catch {
    return null;
  }
}

interface LocalPayment {
  attempt: LogEntry;
  outcome?: LogEntry;
}

/** Whether the report needs the operator's attention. */
export function needsAttention(report: ReconcileReport): boolean {
  return (
    report.missingOnChain.length > 0 ||
    report.landedDespiteFailure.length > 0 ||
    report.mismatched.length > 0 ||
    report.notInLog.length > 0
  );
}

export function reconcile(entries: readonly LogEntry[], events: EventsFile): ReconcileReport {
  const local = new Map<string, LocalPayment>();
  for (const entry of entries) {
    const slot = local.get(entry.invoiceHash);
    if (entry.kind === "attempt") {
      if (slot === undefined) {
        local.set(entry.invoiceHash, { attempt: entry });
      }
    } else if (slot !== undefined) {
      slot.outcome = entry;
    }
  }

  const onChain = new Map<string, ReceiptBody>();
  for (const raw of events.events) {
    const event = decodeEvent(raw);
    if (event.kind === "Receipt") {
      onChain.set(toHex(event.body.invoiceHash), event.body);
    }
  }

  const report: ReconcileReport = { confirmed: [], missingOnChain: [], landedDespiteFailure: [], mismatched: [], notInLog: [] };

  for (const [invoiceHash, payment] of local) {
    const receipt = onChain.get(invoiceHash);
    const amount = BigInt(payment.attempt.amount);
    const state = payment.outcome?.kind ?? "pending";
    if (receipt === undefined) {
      if (state === "settled") {
        const item: ReconcileReport["missingOnChain"][number] = { invoiceHash, amount };
        if (payment.outcome?.transaction !== undefined) {
          item.transaction = payment.outcome.transaction;
        }
        report.missingOnChain.push(item);
      }
      continue;
    }
    if (state !== "settled") {
      const item: ReconcileReport["landedDespiteFailure"][number] = {
        invoiceHash,
        amount: receipt.amount,
        local: state === "failed" ? "failed" : "pending",
        nonce: receipt.nonce,
      };
      if (payment.outcome?.errorReason !== undefined) {
        item.errorReason = payment.outcome.errorReason;
      }
      report.landedDespiteFailure.push(item);
      continue;
    }
    const fields: ("amount" | "provider" | "payee")[] = [];
    if (receipt.amount !== amount) {
      fields.push("amount");
    }
    if (receipt.provider !== BigInt(payment.attempt.provider)) {
      fields.push("provider");
    }
    const payee = accountBytes(payment.attempt.payTo);
    if (payee === null || !equalBytes(receipt.payee, payee)) {
      fields.push("payee");
    }
    if (fields.length > 0) {
      report.mismatched.push({ invoiceHash, amount, fields });
    } else {
      report.confirmed.push({ invoiceHash, amount, nonce: receipt.nonce });
    }
  }

  for (const [invoiceHash, receipt] of onChain) {
    if (!local.has(invoiceHash)) {
      report.notInLog.push({ invoiceHash, amount: receipt.amount, nonce: receipt.nonce });
    }
  }
  return report;
}
