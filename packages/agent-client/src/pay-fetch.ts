/**
 * `payFetch`: fetch, and on `402 Payment Required` pay through the agent's
 * vault with x402 `vault-exact`, if every client-side layer agrees:
 *
 * 1. spend-policy `decide` (for the URL actually requested),
 * 2. replay-guard (new invoice, fresh vault nonce, nothing in flight),
 * 3. capped-signer (the only holder of the key).
 *
 * The outcome goes into the local receipt log. The vault on chain is still
 * the source of truth: it enforces its own caps, allowlist and replay rules.
 */

import type { AccountAddress } from "@concordium/web-sdk";
import {
  CONCORDIUM_TESTNET,
  VaultExactClient,
  invoiceHash,
  type TransactionSigner,
} from "@claw-pay-concordium/x402-vault";
import { x402Client, x402HTTPClient } from "@x402/core/client";
import type { PaymentPayload, PaymentRequired, SettleResponse } from "@x402/core/types";

import { SignRefused } from "./capped-signer.ts";
import { utcDay, type PaymentRecord, type ReceiptLog } from "./receipt-log.ts";
import { ReplayGuard } from "./replay-guard.ts";
import { decide, type SpendPolicy } from "./spend-policy.ts";

/** What the client needs to read from the chain before paying. */
export interface AgentChain {
  /** The vault's next nonce, from its `view`. */
  vaultNonce(): Promise<bigint>;
  /** The agent account's next sequence number. */
  accountSequence(): Promise<bigint>;
  /**
   * The vault's own spend for its current UTC day, from its `view`. When it
   * is for today and higher than the local log's total, it is used instead.
   */
  vaultSpentToday?(): Promise<{ day: number; spent: bigint }>;
}

export type RefusalLayer = "protocol" | "spend-policy" | "replay-guard" | "capped-signer";

/** Thrown when the client will not pay. Nothing was signed or sent. */
export class PaymentRefused extends Error {
  override name = "PaymentRefused";
  readonly layer: RefusalLayer;
  readonly reasons: readonly string[];

  constructor(layer: RefusalLayer, reasons: readonly string[]) {
    super(`payment refused by ${layer}: ${reasons.join(", ")}`);
    this.layer = layer;
    this.reasons = reasons;
  }
}

export interface PayingFetchOptions {
  policy: SpendPolicy;
  /** The agent account (the transaction sender). */
  agent: AccountAddress.Type;
  /** The capped signer. */
  sign: TransactionSigner;
  chain: AgentChain;
  log: ReceiptLog;
  fetch?: typeof globalThis.fetch;
  /** Current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

export type PayingFetch = (url: string, init?: RequestInit) => Promise<Response>;

function headerReader(response: Response): (name: string) => string | null {
  return (name) => response.headers.get(name);
}

export function createPayingFetch(options: PayingFetchOptions): PayingFetch {
  const doFetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? Date.now;
  const guard = new ReplayGuard(options.log);

  return async (url, init) => {
    const first = await doFetch(url, init);
    if (first.status !== 402) {
      return first;
    }

    const parser = new x402HTTPClient(new x402Client());
    let paymentRequired: PaymentRequired;
    try {
      paymentRequired = parser.getPaymentRequiredResponse(headerReader(first));
    } catch {
      throw new PaymentRefused("protocol", ["invalid_payment_required"]);
    }

    // Layer 1: spend-policy. Today's spend is the larger of the local log's
    // total and the vault's own figure, when the vault reports today.
    const today = utcDay(now());
    let spentToday = options.log.spentInUtcDay(today);
    if (options.chain.vaultSpentToday !== undefined) {
      const onChain = await options.chain.vaultSpentToday();
      if (onChain.day === today && onChain.spent > spentToday) {
        spentToday = onChain.spent;
      }
    }
    const decision = decide({ requestUrl: url, offers: paymentRequired.accepts, spentToday }, options.policy);
    if (!decision.allow) {
      throw new PaymentRefused("spend-policy", decision.reasons);
    }
    const offer = decision.offer;

    // Layer 2: replay-guard.
    const vaultNonce = await options.chain.vaultNonce();
    const invoice = Buffer.from(invoiceHash(offer)).toString("hex");
    const acquired = guard.acquire(invoice, vaultNonce);
    if (!acquired.ok) {
      throw new PaymentRefused("replay-guard", acquired.reasons);
    }

    try {
      // Layer 3: the capped signer signs inside the scheme client.
      const client = new x402Client()
        .register(
          CONCORDIUM_TESTNET,
          new VaultExactClient({
            vault: options.policy.vault,
            agent: options.agent,
            sign: options.sign,
            energy: options.policy.maxEnergy,
            vaultNonce: () => Promise.resolve(vaultNonce),
            accountSequence: () => options.chain.accountSequence(),
            now,
          }),
        )
        .setSpendControls(false); // USD-based; spend-policy is the gate for CCD.
      const http = new x402HTTPClient(client);
      let payload: PaymentPayload;
      try {
        // Only the offer spend-policy allowed is on the table.
        payload = await http.createPaymentPayload({ ...paymentRequired, accepts: [decision.requirements] });
      } catch (error) {
        if (error instanceof SignRefused) {
          throw new PaymentRefused("capped-signer", error.reasons);
        }
        throw error;
      }

      // Signed but not yet sent: from here the payment may land.
      const record: PaymentRecord = {
        url,
        provider: offer.provider,
        payTo: offer.payTo,
        amount: offer.amount,
        invoiceHash: invoice,
        vaultNonce,
      };
      options.log.append("attempt", record, {}, new Date(now()));

      let second: Response;
      try {
        const headers = new Headers(init?.headers);
        for (const [name, value] of Object.entries(http.encodePaymentSignatureHeader(payload))) {
          headers.set(name, value);
        }
        second = await doFetch(url, { ...init, headers });
      } catch (error) {
        options.log.append("failed", record, { errorReason: "request_failed" }, new Date(now()));
        throw error;
      }

      let settle: SettleResponse | null = null;
      try {
        settle = http.getPaymentSettleResponse(headerReader(second));
      } catch {
        settle = null;
      }
      if (settle?.success === true) {
        options.log.append("settled", record, { transaction: settle.transaction }, new Date(now()));
      } else {
        const errorReason = settle?.errorReason ?? "no_settle_response";
        options.log.append("failed", record, { errorReason }, new Date(now()));
      }
      return second;
    } finally {
      acquired.release();
    }
  };
}
