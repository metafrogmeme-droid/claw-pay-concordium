/**
 * The seller's x402 `vault-exact` duties (see docs/x402-vault-scheme.md,
 * "Seller duties"): a fresh invoice for every 402 answer, honoured once,
 * only for the resource it was issued for, only for the offer as issued,
 * and only for a limited time.
 *
 * The invoice hash the agent pays covers the invoice id, provider, payTo
 * and amount, and the vault pays each invoice hash at most once. This book
 * adds the binding to the resource, which x402 does not give the scheme.
 */

import { isDeepStrictEqual } from "node:util";

import { newRequirements, type OfferInput } from "@claw-pay-concordium/x402-vault";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

export type RedeemRefusal = "unknown_invoice" | "invoice_expired" | "invoice_used" | "wrong_resource" | "offer_changed";

export type Redeemed = { ok: true; requirements: PaymentRequirements } | { ok: false; reason: RedeemRefusal };

export interface InvoiceBookOptions {
  /** Everything in the offer except the amount, which each route sets. */
  offer: Omit<OfferInput, "amount">;
  /** How long an invoice stays payable. Default 5 minutes. */
  ttlMs?: number;
  /** Most invoices kept at once. Default 1000. */
  maxOutstanding?: number;
  now?: () => number;
}

interface Entry {
  path: string;
  requirements: PaymentRequirements;
  issuedAt: number;
  used: boolean;
}

export class InvoiceBook {
  readonly #offer: Omit<OfferInput, "amount">;
  readonly #ttlMs: number;
  readonly #max: number;
  readonly #now: () => number;
  /** Insertion order is age order. */
  readonly #entries = new Map<string, Entry>();

  constructor(options: InvoiceBookOptions) {
    this.#offer = options.offer;
    this.#ttlMs = options.ttlMs ?? 5 * 60_000;
    this.#max = options.maxOutstanding ?? 1000;
    this.#now = options.now ?? Date.now;
    if (this.#max < 1 || this.#ttlMs < 1) {
      throw new RangeError("maxOutstanding and ttlMs must be positive");
    }
  }

  get size(): number {
    return this.#entries.size;
  }

  #prune(now: number): void {
    for (const [id, entry] of this.#entries) {
      if (now - entry.issuedAt > this.#ttlMs) {
        this.#entries.delete(id);
      }
    }
  }

  /** A fresh invoice for `path` at `amount` micro-CCD. */
  issue(path: string, amount: bigint): PaymentRequirements {
    const now = this.#now();
    this.#prune(now);
    while (this.#entries.size >= this.#max) {
      const oldest = this.#entries.keys().next();
      if (oldest.done === true) {
        break;
      }
      this.#entries.delete(oldest.value);
    }
    const requirements = newRequirements({ ...this.#offer, amount });
    this.#entries.set(String(requirements.extra["invoiceId"]), { path, requirements, issuedAt: now, used: false });
    return requirements;
  }

  /**
   * Check a payment against the invoice it names, for `path`. On success the
   * invoice is marked used at once, before settling, so a second payment of
   * it (even a concurrent one) is refused.
   */
  redeem(payload: PaymentPayload, path: string): Redeemed {
    const invoiceId = payload.accepted.extra["invoiceId"];
    const entry = typeof invoiceId === "string" ? this.#entries.get(invoiceId) : undefined;
    if (typeof invoiceId !== "string" || entry === undefined) {
      return { ok: false, reason: "unknown_invoice" };
    }
    if (this.#now() - entry.issuedAt > this.#ttlMs) {
      this.#entries.delete(invoiceId);
      return { ok: false, reason: "invoice_expired" };
    }
    if (entry.used) {
      return { ok: false, reason: "invoice_used" };
    }
    if (entry.path !== path) {
      return { ok: false, reason: "wrong_resource" };
    }
    if (!isDeepStrictEqual(payload.accepted, entry.requirements)) {
      return { ok: false, reason: "offer_changed" };
    }
    entry.used = true;
    return { ok: true, requirements: entry.requirements };
  }
}
