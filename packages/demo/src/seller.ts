/**
 * The demo x402 seller: a `node:http` handler that answers paid routes with
 * `402 Payment Required` (standard x402 v2 `PAYMENT-REQUIRED` header) and,
 * on a `PAYMENT-SIGNATURE`, checks the invoice and settles through the
 * `vault-exact` facilitator before serving the body.
 *
 * Errors never leak internals: malformed input gets 400, unknown paths 404,
 * refused invoices and failed settlements 402, and anything unexpected a
 * bare 500 or 502.
 */

import type { IncomingMessage, ServerResponse } from "node:http";

import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

import type { InvoiceBook } from "./invoice-book.ts";
import type { SellerRoute } from "./seller-config.ts";

export interface Settler {
  settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse>;
}

export interface SellerOptions {
  routes: readonly SellerRoute[];
  book: InvoiceBook;
  facilitator: Settler;
  /** Origin used in `resource.url`, e.g. http://127.0.0.1:8402. */
  origin: string;
  /** Called after every settlement attempt. */
  onSettle?: (result: SettleResponse) => void;
}

function json(response: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  response.writeHead(status, { "content-type": "application/json", ...headers }).end(JSON.stringify(body));
}

async function handle(options: SellerOptions, request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = new URL(request.url ?? "/", "http://localhost").pathname;
  if (request.method !== "GET") {
    json(response, 405, { error: "method_not_allowed" });
    return;
  }
  if (path === "/health") {
    json(response, 200, { ok: true });
    return;
  }
  const route = options.routes.find((candidate) => candidate.path === path);
  if (route === undefined) {
    json(response, 404, { error: "not_found" });
    return;
  }

  const signature = request.headers["payment-signature"];
  if (signature === undefined) {
    const requirements = options.book.issue(path, route.price);
    const header = encodePaymentRequiredHeader({
      x402Version: 2,
      resource: { url: `${options.origin}${path}`, mimeType: route.contentType },
      accepts: [requirements],
    });
    json(response, 402, { error: "payment_required" }, { "PAYMENT-REQUIRED": header });
    return;
  }

  let payload: PaymentPayload;
  try {
    if (typeof signature !== "string") {
      throw new Error("one PAYMENT-SIGNATURE header expected");
    }
    payload = decodePaymentSignatureHeader(signature);
  } catch {
    json(response, 400, { error: "invalid_payment_signature" });
    return;
  }

  const redeemed = options.book.redeem(payload, path);
  if (!redeemed.ok) {
    json(response, 402, { error: redeemed.reason });
    return;
  }

  let result: SettleResponse;
  try {
    result = await options.facilitator.settle(payload, redeemed.requirements);
  } catch {
    json(response, 502, { error: "settlement_failed" });
    return;
  }
  options.onSettle?.(result);
  const paymentResponse = { "PAYMENT-RESPONSE": encodePaymentResponseHeader(result) };
  if (!result.success) {
    json(response, 402, { error: result.errorReason ?? "settlement_failed" }, paymentResponse);
    return;
  }
  response.writeHead(200, { "content-type": route.contentType, ...paymentResponse }).end(route.body);
}

/** The seller's request handler. */
export function createSeller(options: SellerOptions): (request: IncomingMessage, response: ServerResponse) => void {
  return (request, response) => {
    handle(options, request, response).catch(() => {
      if (!response.headersSent) {
        response.writeHead(500).end();
      } else {
        response.end();
      }
    });
  };
}
