import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { AccountAddress } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET } from "@claw-pay-concordium/x402-vault";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";
import { decodePaymentRequiredHeader, decodePaymentResponseHeader, encodePaymentSignatureHeader } from "@x402/core/http";
import type { PaymentPayload, PaymentRequirements, SettleResponse } from "@x402/core/types";

import { InvoiceBook } from "./invoice-book.ts";
import { createSeller, type Settler } from "./seller.ts";

const ROUTES = [
  { path: "/weather", price: 1_000_000n, contentType: "application/json", body: '{"forecast":"sunny"}' },
  { path: "/news", price: 2_000_000n, contentType: "text/plain", body: "headlines" },
];

let server: Server;
let origin: string;
let settleCalls: { payload: PaymentPayload; requirements: PaymentRequirements }[];
let settleWith: () => Promise<SettleResponse>;

const settler: Settler = {
  settle: (payload, requirements) => {
    settleCalls.push({ payload, requirements });
    return settleWith();
  },
};

before(async () => {
  const book = new InvoiceBook({
    offer: { network: CONCORDIUM_TESTNET, payTo: AccountAddress.toBase58(addressOf(0x03)), feePayer: AccountAddress.toBase58(addressOf(0x09)), provider: 10n },
  });
  server = createServer((request, response) => {
    createSeller({ routes: ROUTES, book, facilitator: settler, origin })(request, response);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  settleCalls = [];
  settleWith = () => Promise.resolve({ success: true, transaction: "ab".repeat(32), network: CONCORDIUM_TESTNET, payer: "agent" });
});

async function offer(path: string): Promise<PaymentRequirements> {
  const response = await fetch(`${origin}${path}`);
  assert.equal(response.status, 402);
  const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
  assert.equal(required.accepts.length, 1);
  const first = required.accepts[0];
  assert.ok(first !== undefined);
  return first;
}

function pay(path: string, requirements: PaymentRequirements): Promise<Response> {
  const payload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: { signedTransaction: {} } };
  return fetch(`${origin}${path}`, { headers: { "PAYMENT-SIGNATURE": encodePaymentSignatureHeader(payload) } });
}

describe("demo seller", () => {
  test("/health is free; other methods and paths are refused", async () => {
    assert.equal((await fetch(`${origin}/health`)).status, 200);
    assert.equal((await fetch(`${origin}/weather`, { method: "POST" })).status, 405);
    assert.equal((await fetch(`${origin}/nope`)).status, 404);
  });

  test("a paid route answers 402 with a standard PAYMENT-REQUIRED offer", async () => {
    const response = await fetch(`${origin}/news`);
    assert.equal(response.status, 402);
    const required = decodePaymentRequiredHeader(response.headers.get("PAYMENT-REQUIRED") ?? "");
    assert.equal(required.x402Version, 2);
    assert.equal(required.resource.url, `${origin}/news`);
    const first = required.accepts[0];
    assert.ok(first !== undefined);
    assert.equal(first.scheme, "vault-exact");
    assert.equal(first.amount, "2000000");
  });

  test("a valid payment is settled once and served", async () => {
    const requirements = await offer("/weather");
    const response = await pay("/weather", requirements);
    assert.equal(response.status, 200);
    assert.equal(await response.text(), '{"forecast":"sunny"}');
    const settled = decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "");
    assert.equal(settled.success, true);
    assert.equal(settleCalls.length, 1);
    assert.deepEqual(settleCalls[0]?.requirements, requirements);
  });

  test("a replayed invoice is refused without a second settlement", async () => {
    const requirements = await offer("/weather");
    assert.equal((await pay("/weather", requirements)).status, 200);
    const replay = await pay("/weather", requirements);
    assert.equal(replay.status, 402);
    assert.deepEqual(await replay.json(), { error: "invoice_used" });
    assert.equal(settleCalls.length, 1);
  });

  test("an invoice used for another resource is refused without settlement", async () => {
    const requirements = await offer("/weather");
    const response = await pay("/news", requirements);
    assert.equal(response.status, 402);
    assert.deepEqual(await response.json(), { error: "wrong_resource" });
    assert.equal(settleCalls.length, 0);
  });

  test("a malformed payment header is a 400", async () => {
    const response = await fetch(`${origin}/weather`, { headers: { "PAYMENT-SIGNATURE": "%%% not base64 %%%" } });
    assert.equal(response.status, 400);
    assert.equal(settleCalls.length, 0);
  });

  test("a failed settlement is a 402 carrying the facilitator's reason", async () => {
    settleWith = () => Promise.resolve({ success: false, errorReason: "dry_run_rejected", transaction: "", network: CONCORDIUM_TESTNET });
    const response = await pay("/weather", await offer("/weather"));
    assert.equal(response.status, 402);
    assert.equal(decodePaymentResponseHeader(response.headers.get("PAYMENT-RESPONSE") ?? "").errorReason, "dry_run_rejected");
  });

  test("a facilitator crash is a bare 502 that leaks nothing", async () => {
    settleWith = () => Promise.reject(new Error("secret internal detail"));
    const response = await pay("/weather", await offer("/weather"));
    assert.equal(response.status, 502);
    assert.ok(!(await response.text()).includes("secret"));
  });
});
