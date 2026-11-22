/** Turning a verification report into what the page shows. */

import { AccountAddress } from "@concordium/web-sdk";
import { formatCcd, toHex, type EventsFile, type Report } from "@claw-pay-concordium/verifier";

export interface ReceiptRow {
  nonce: string;
  time: string;
  amount: string;
  provider: string;
  /** Shortened for the table. */
  payee: string;
  /** The full Base58 address, for a tooltip. */
  payeeFull: string;
  hash: string;
}

export interface ViewModel {
  ok: boolean;
  headline: string;
  summary: string;
  receipts: ReceiptRow[];
  issues: string[];
}

function payee(bytes: Uint8Array): string {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return AccountAddress.toBase58(AccountAddress.fromBuffer(copy.buffer));
}

export function toViewModel(file: EventsFile, report: Report): ViewModel {
  const vault = `<${String(file.vault.index)},${String(file.vault.subindex)}>`;
  return {
    ok: report.ok,
    headline: report.ok ? "Verified" : "Not verified",
    summary: report.ok
      ? `Vault ${vault}: ${String(report.receipts.length)} receipts from ${String(file.events.length)} events. Every hash and link checks out, every payment respected the rules in force, and the chain ends at the head the contract reports (${toHex(file.view.receiptHead).slice(0, 16)}…).`
      : `Vault ${vault}: ${String(report.issues.length)} issue(s) in ${String(file.events.length)} events.`,
    receipts: report.receipts.map(({ body, hash }) => {
      const full = payee(body.payee);
      return {
        nonce: String(body.nonce),
        time: new Date(Number(body.timestamp)).toISOString().replace(".000Z", "Z"),
        amount: formatCcd(body.amount),
        provider: String(body.provider),
        payee: `${full.slice(0, 8)}…${full.slice(-6)}`,
        payeeFull: full,
        hash: `${toHex(hash).slice(0, 16)}…`,
      };
    }),
    issues: report.issues.map((issue) => `${issue.event === null ? "file" : `event ${String(issue.event)}`}: ${issue.code}: ${issue.message}`),
  };
}
