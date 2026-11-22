/**
 * replay-guard: refuses to start a payment the client has already started,
 * one built on a stale vault nonce, or a second one while one is in flight.
 *
 * The vault refuses reused nonces and invoices on chain anyway (INV-6). This
 * layer stops the client from signing them at all, so a hostile seller that
 * re-sends an old invoice gets nothing signed.
 */

import type { ReceiptLog } from "./receipt-log.ts";

export type ReplayReason = "invoice_already_attempted" | "stale_nonce" | "payment_in_flight";

export type Acquired = { ok: true; release: () => void } | { ok: false; reasons: ReplayReason[] };

export class ReplayGuard {
  readonly #log: ReceiptLog;
  #busy = false;

  constructor(log: ReceiptLog) {
    this.#log = log;
  }

  /** Every reason this payment may not start now. */
  check(invoiceHash: string, vaultNonce: bigint): ReplayReason[] {
    const reasons: ReplayReason[] = [];
    if (this.#log.attempted(invoiceHash)) {
      reasons.push("invoice_already_attempted");
    }
    const highest = this.#log.highestSettledNonce();
    if (highest !== null && vaultNonce <= highest) {
      reasons.push("stale_nonce");
    }
    if (this.#busy) {
      reasons.push("payment_in_flight");
    }
    return reasons;
  }

  /**
   * Check and, if clear, take the in-flight lock in one step. Call `release`
   * when the payment has ended, whatever the outcome.
   */
  acquire(invoiceHash: string, vaultNonce: bigint): Acquired {
    const reasons = this.check(invoiceHash, vaultNonce);
    if (reasons.length > 0) {
      return { ok: false, reasons };
    }
    this.#busy = true;
    let released = false;
    return {
      ok: true,
      release: () => {
        if (!released) {
          released = true;
          this.#busy = false;
        }
      },
    };
  }
}
