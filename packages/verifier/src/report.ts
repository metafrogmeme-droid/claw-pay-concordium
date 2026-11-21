/** Human-readable lines for a verification report. */

import { toHex } from "./bytes.ts";
import type { EventsFile } from "./events-file.ts";
import type { Report } from "./verify.ts";

const MICRO_PER_CCD = 1_000_000n;

/** Format micro-CCD as CCD with six decimals. */
export function formatCcd(micro: bigint): string {
  const whole = micro / MICRO_PER_CCD;
  const fraction = (micro % MICRO_PER_CCD).toString().padStart(6, "0");
  return `${whole.toString()}.${fraction} CCD`;
}

function short(bytes: Uint8Array): string {
  return `${toHex(bytes).slice(0, 12)}…`;
}

export function formatReport(file: EventsFile, report: Report): string[] {
  const lines = [
    `Vault <${String(file.vault.index)},${String(file.vault.subindex)}>: ${String(file.events.length)} events, ${String(report.receipts.length)} receipts`,
  ];
  for (const { body, hash } of report.receipts) {
    const time = new Date(Number(body.timestamp)).toISOString();
    lines.push(
      `  receipt ${String(body.nonce)}  ${time}  ${formatCcd(body.amount)}  provider ${String(body.provider)}  payee ${short(body.payee)}  hash ${short(hash)}`,
    );
  }
  for (const issue of report.issues) {
    const where = issue.event === null ? "file" : `event ${String(issue.event)}`;
    lines.push(`  ISSUE [${where}] ${issue.code}: ${issue.message}`);
  }
  lines.push(
    report.ok
      ? `VERIFIED: ${String(report.receipts.length)} receipts; chain intact, rules respected, head ${short(file.view.receiptHead)} matches the contract`
      : `FAILED: ${String(report.issues.length)} issue(s)`,
  );
  return lines;
}
