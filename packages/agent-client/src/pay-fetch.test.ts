import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, beforeEach, describe, test } from "node:test";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import {
  CONCORDIUM_TESTNET,
  VaultExactFacilitator,
  newRequirements,
} from "@claw-pay-concordium/x402-vault";
import { FakeChain, addressOf, ephemeralAccount } from "@claw-pay-concordium/x402-vault/test-support";
import { decodePaymentSignatureHeader, encodePaymentRequiredHeader, encodePaymentResponseHeader } from "@x402/core/http";
import type { PaymentRequirements } from "@x402/core/types";

import { createCappedSigner } from "./capped-signer.ts";
import { PaymentRefused, createPayingFetch, type PayingFetch } from "./pay-fetch.ts";
import { MemoryLogStore, ReceiptLog, utcDay } from "./receipt-log.ts";
import type { SpendPolicy } from "./spend-policy.ts";

const VAULT = ContractAddress.create(7, 0);
const SELLER = addressOf(0x03);
const agentKey = ephemeralAccount(0x02);
const sponsorKey = ephemeralAccount(0x09);

/** A local x402 seller on 127.0.0.1, settling through the real facilitator over an in-memory chain. */
interface Seller {
  chain: FakeChain;
  amount: bigint;
  provider: bigint;
  /** Re-send the same offer (same invoiceId) on every 402. */
  replayOffer: boolean;
  paymentsSeen: number;
  nextNonce: bigint;
}

let server: Server;
let origin: string;
let seller: Seller;
let lastOffer: PaymentRequirements | null = null;
const issued = new Map<string, { path: string; requirements: PaymentRequirements; used: boolean }>();

function facilitator(): VaultExactFacilitator {
  return new VaultExactFacilitator({
    network: CONCORDIUM_TESTNET,
    sponsor: { address: sponsorKey.address, signer: sponsorKey.signer },
    vaults: [VAULT],
    maxEnergy: 50_000n,
    chain: seller.chain,
  });
}

function offerFor(path: string): PaymentRequirements {
  if (seller.replayOffer && lastOffer !== null) {
    return lastOffer;
  }
  const requirements = newRequirements({
    network: CONCORDIUM_TESTNET,
    amount: seller.amount,
    payTo: AccountAddress.toBase58(SELLER),
    feePayer: AccountAddress.toBase58(sponsorKey.address),
    provider: seller.provider,
  });
  issued.set(String(requirements.extra["invoiceId"]), { path, requirements, used: false });
  lastOffer = requirements;
  return requirements;
}

async function handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const path = request.url ?? "/";
  if (path === "/free") {
    response.writeHead(200, { "content-type": "application/json" }).end('{"free":true}');
    return;
  }
  const signature = request.headers["payment-signature"];
  if (typeof signature !== "string") {
    const header = encodePaymentRequiredHeader({ x402Version: 2, resource: { url: `${origin}${path}` }, accepts: [offerFor(path)] });
    response.writeHead(402, { "PAYMENT-REQUIRED": header }).end();
    return;
  }
  seller.paymentsSeen += 1;
  const payload = decodePaymentSignatureHeader(signature);
  const invoice = issued.get(String(payload.accepted.extra["invoiceId"]));
  // Seller duty: honour an invoice once, and only for the resource it was issued for.
  if (invoice === undefined || invoice.used || invoice.path !== path) {
    response.writeHead(402).end();
    return;
  }
  invoice.used = true;
  const settle = await facilitator().settle(payload, invoice.requirements);
  if (settle.success) {
    seller.nextNonce += 1n;
  }
  response
    .writeHead(settle.success ? 200 : 402, { "PAYMENT-RESPONSE": encodePaymentResponseHeader(settle), "content-type": "application/json" })
    .end(settle.success ? '{"forecast":"sunny"}' : "{}");
}

before(async () => {
  server = createServer((request, response) => {
    handle(request, response).catch(() => response.writeHead(500).end());
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  origin = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

let log: ReceiptLog;

function policy(overrides: Partial<SpendPolicy> = {}): SpendPolicy {
  return {
    vault: VAULT,
    perPaymentMax: 1_000_000n,
    dailyMax: 3_000_000n,
    maxTimeoutSeconds: 60,
    maxEnergy: 30_000n,
    providers: [{ origin, provider: 10n, payTo: AccountAddress.toBase58(SELLER) }],
    ...overrides,
  };
}

function payingFetch(p: SpendPolicy = policy(), vault: ContractAddress.Type = VAULT): PayingFetch {
  return createPayingFetch({
    policy: p,
    agent: agentKey.address,
    sign: createCappedSigner({ signer: agentKey.signer, agent: agentKey.address, vault, perPaymentMax: p.perPaymentMax, maxEnergy: p.maxEnergy }),
    chain: { vaultNonce: () => Promise.resolve(seller.nextNonce), accountSequence: () => Promise.resolve(1n) },
    log,
  });
}

async function refusal(promise: Promise<Response>): Promise<PaymentRefused> {
  const error = await promise.then(
    () => assert.fail("expected the client to refuse"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof PaymentRefused, String(error));
  return error;
}

beforeEach(() => {
  const chain = new FakeChain(VAULT, agentKey.address, SELLER);
  chain.addAccount(agentKey);
  chain.addAccount(sponsorKey);
  seller = { chain, amount: 1_000_000n, provider: 10n, replayOffer: false, paymentsSeen: 0, nextNonce: 0n };
  lastOffer = null;
  issued.clear();
  log = ReceiptLog.open(new MemoryLogStore());
});

describe("payFetch against a local x402 seller", () => {
  test("a non-402 response passes through untouched", async () => {
    const response = await payingFetch()(`${origin}/free`);
    assert.equal(response.status, 200);
    assert.equal(log.entries.length, 0);
  });

  test("pays, gets the resource, and logs attempt then settled", async () => {
    const response = await payingFetch()(`${origin}/weather`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { forecast: "sunny" });
    assert.equal(seller.paymentsSeen, 1);
    assert.deepEqual(log.entries.map((entry) => entry.kind), ["attempt", "settled"]);
    const settled = log.entries[1];
    assert.ok(settled !== undefined);
    assert.equal(settled.transaction, "ab".repeat(32));
    assert.equal(settled.amount, "1000000");
    assert.equal(log.spentInUtcDay(utcDay(Date.now())), 1_000_000n);
  });

  test("an origin the policy does not know is never paid", async () => {
    const other = policy({ providers: [{ origin: "https://seller.example", provider: 10n }] });
    const error = await refusal(payingFetch(other)(`${origin}/weather`));
    assert.equal(error.layer, "spend-policy");
    assert.deepEqual(error.reasons, ["unknown_origin"]);
    assert.equal(seller.paymentsSeen, 0);
    assert.equal(log.entries.length, 0);
  });

  test("a seller naming another provider is never paid", async () => {
    seller.provider = 11n;
    const error = await refusal(payingFetch()(`${origin}/weather`));
    assert.deepEqual(error.reasons, ["provider_mismatch"]);
    assert.equal(seller.paymentsSeen, 0);
  });

  test("an offer over the per-payment cap is never paid", async () => {
    seller.amount = 1_000_001n;
    const error = await refusal(payingFetch()(`${origin}/weather`));
    assert.deepEqual(error.reasons, ["over_per_payment"]);
    assert.equal(seller.paymentsSeen, 0);
  });

  test("a failed settlement is logged as failed and does not count as spent", async () => {
    seller.chain.finalization = () => Promise.resolve({ status: "finalized", success: false, rejectCode: -6, message: "Paused" });
    const response = await payingFetch()(`${origin}/weather`);
    assert.equal(response.status, 402);
    assert.deepEqual(log.entries.map((entry) => entry.kind), ["attempt", "failed"]);
    assert.equal(log.entries[1]?.errorReason, "transaction_rejected");
    assert.equal(log.spentInUtcDay(utcDay(Date.now())), 0n);
  });

  test("a seller re-sending a paid invoice is refused by the replay-guard", async () => {
    seller.replayOffer = true;
    const pay = payingFetch();
    assert.equal((await pay(`${origin}/weather`)).status, 200);
    const error = await refusal(pay(`${origin}/weather`));
    assert.equal(error.layer, "replay-guard");
    assert.deepEqual(error.reasons, ["invoice_already_attempted"]);
    assert.equal(seller.paymentsSeen, 1);
  });

  test("the daily cap holds across payments", async () => {
    const pay = payingFetch(policy({ dailyMax: 2_000_000n }));
    assert.equal((await pay(`${origin}/a`)).status, 200);
    assert.equal((await pay(`${origin}/b`)).status, 200);
    const error = await refusal(pay(`${origin}/c`));
    assert.deepEqual(error.reasons, ["over_daily"]);
    assert.equal(seller.paymentsSeen, 2);
  });

  test("the vault's own spend for today is a floor under the local log", async () => {
    const today = utcDay(Date.now());
    const withVaultSpend = (day: number): PayingFetch =>
      createPayingFetch({
        policy: policy(),
        agent: agentKey.address,
        sign: createCappedSigner({ signer: agentKey.signer, agent: agentKey.address, vault: VAULT, perPaymentMax: 1_000_000n, maxEnergy: 30_000n }),
        chain: {
          vaultNonce: () => Promise.resolve(seller.nextNonce),
          accountSequence: () => Promise.resolve(1n),
          vaultSpentToday: () => Promise.resolve({ day, spent: 2_500_000n }),
        },
        log,
      });
    // The local log is empty, but the vault has already spent 2.5 of 3 CCD today.
    const error = await refusal(withVaultSpend(today)(`${origin}/weather`));
    assert.deepEqual(error.reasons, ["over_daily"]);
    assert.equal(seller.paymentsSeen, 0);
    // A figure for another day is ignored.
    assert.equal((await withVaultSpend(today - 1)(`${origin}/weather`)).status, 200);
  });

  test("the capped signer is the last word: a misconfigured signer sends nothing", async () => {
    const error = await refusal(payingFetch(policy(), ContractAddress.create(8, 0))(`${origin}/weather`));
    assert.equal(error.layer, "capped-signer");
    assert.deepEqual(error.reasons, ["wrong_vault"]);
    assert.equal(seller.paymentsSeen, 0);
    assert.equal(log.entries.length, 0);
  });

  test("a 402 without a valid payment request is refused", async () => {
    const pay = createPayingFetch({
      policy: policy(),
      agent: agentKey.address,
      sign: () => Promise.reject(new Error("must not sign")),
      chain: { vaultNonce: () => Promise.resolve(0n), accountSequence: () => Promise.resolve(1n) },
      log,
      fetch: () => Promise.resolve(new Response(null, { status: 402 })),
    });
    const error = await refusal(pay(`${origin}/weather`));
    assert.equal(error.layer, "protocol");
  });
});
