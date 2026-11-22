import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import { CONCORDIUM_TESTNET, newRequirements } from "@claw-pay-concordium/x402-vault";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";
import type { PaymentRequirements } from "@x402/core/types";

import { PolicyError, decide, parsePolicy, type DecideInput, type SpendPolicy } from "./spend-policy.ts";

const SELLER = AccountAddress.toBase58(addressOf(0x03));
const OTHER = AccountAddress.toBase58(addressOf(0x05));
const SPONSOR = AccountAddress.toBase58(addressOf(0x09));
const URL_OK = "https://seller.example/weather?city=Zug";

const POLICY: SpendPolicy = {
  vault: ContractAddress.create(7, 0),
  perPaymentMax: 1_000_000n,
  dailyMax: 3_000_000n,
  maxTimeoutSeconds: 60,
  maxEnergy: 30_000n,
  providers: [{ origin: "https://seller.example", provider: 10n, payTo: SELLER }],
};

function offer(overrides: { amount?: bigint; payTo?: string; provider?: bigint; feePayer?: string; maxTimeoutSeconds?: number } = {}): PaymentRequirements {
  return newRequirements({
    network: CONCORDIUM_TESTNET,
    amount: overrides.amount ?? 1_000_000n,
    payTo: overrides.payTo ?? SELLER,
    feePayer: overrides.feePayer ?? SPONSOR,
    provider: overrides.provider ?? 10n,
    maxTimeoutSeconds: overrides.maxTimeoutSeconds ?? 60,
  });
}

function input(offers: PaymentRequirements[], overrides: Partial<DecideInput> = {}): DecideInput {
  return { requestUrl: URL_OK, offers, spentToday: 0n, ...overrides };
}

function reasons(decision: ReturnType<typeof decide>): string[] {
  if (decision.allow) {
    return assert.fail("expected a denial");
  }
  return decision.reasons;
}

describe("decide", () => {
  test("allows a matching offer and returns it parsed", () => {
    const requirements = offer();
    const decision = decide(input([requirements]), POLICY);
    assert.ok(decision.allow);
    assert.equal(decision.requirements, requirements);
    assert.equal(decision.offer.amount, 1_000_000n);
  });

  test("no_vault_exact_offer: nothing usable on testnet", () => {
    const good = offer();
    for (const offers of [
      [],
      [{ ...good, scheme: "exact" }],
      [{ ...good, network: "ccd:00000000000000000000000000000000" as const }],
      [{ ...good, amount: "0" }],
    ]) {
      assert.deepEqual(reasons(decide(input(offers), POLICY)), ["no_vault_exact_offer"]);
    }
  });

  test("unknown_origin: the requested URL decides, path and query do not", () => {
    assert.ok(decide(input([offer()], { requestUrl: "https://seller.example/" }), POLICY).allow);
    for (const requestUrl of ["https://other.example/weather", "http://seller.example/weather", "https://seller.example:8443/", "not a url"]) {
      assert.deepEqual(reasons(decide(input([offer()], { requestUrl }), POLICY)), ["unknown_origin"], requestUrl);
    }
  });

  test("provider_mismatch: the seller names a different provider", () => {
    assert.deepEqual(reasons(decide(input([offer({ provider: 11n })]), POLICY)), ["provider_mismatch"]);
  });

  test("payto_mismatch: only when a wallet is configured", () => {
    assert.deepEqual(reasons(decide(input([offer({ payTo: OTHER })]), POLICY)), ["payto_mismatch"]);
    const noWallet = { ...POLICY, providers: [{ origin: "https://seller.example", provider: 10n }] };
    assert.ok(decide(input([offer({ payTo: OTHER })]), noWallet).allow);
  });

  test("over_per_payment", () => {
    assert.deepEqual(reasons(decide(input([offer({ amount: 1_000_001n })]), POLICY)), ["over_per_payment"]);
  });

  test("over_daily: today's spend plus this payment", () => {
    assert.ok(decide(input([offer()], { spentToday: 2_000_000n }), POLICY).allow);
    assert.deepEqual(reasons(decide(input([offer()], { spentToday: 2_000_001n }), POLICY)), ["over_daily"]);
  });

  test("timeout_too_long", () => {
    const strict = { ...POLICY, maxTimeoutSeconds: 30 };
    assert.ok(decide(input([offer({ maxTimeoutSeconds: 30 })]), strict).allow);
    assert.deepEqual(reasons(decide(input([offer({ maxTimeoutSeconds: 31 })]), strict)), ["timeout_too_long"]);
  });

  test("fee_payer_not_trusted: only when feePayers is set", () => {
    assert.deepEqual(reasons(decide(input([offer()]), { ...POLICY, feePayers: [OTHER] })), ["fee_payer_not_trusted"]);
    assert.ok(decide(input([offer()]), { ...POLICY, feePayers: [OTHER, SPONSOR] }).allow);
  });

  test("reports every failing rule at once", () => {
    const bad = offer({ provider: 11n, amount: 5_000_000n });
    assert.deepEqual(reasons(decide(input([bad]), POLICY)), ["provider_mismatch", "over_per_payment", "over_daily"]);
  });

  test("picks the first acceptable offer", () => {
    const tooDear = offer({ amount: 2_000_000n });
    const fine = offer({ amount: 500_000n });
    const decision = decide(input([tooDear, fine]), POLICY);
    assert.ok(decision.allow);
    assert.equal(decision.requirements, fine);
  });
});

describe("parsePolicy", () => {
  const valid = {
    vault: { index: "7", subindex: "0" },
    perPaymentMax: "1000000",
    dailyMax: "3000000",
    maxTimeoutSeconds: 60,
    maxEnergy: "30000",
    providers: [{ origin: "https://seller.example", provider: "10", payTo: SELLER }],
    feePayers: [SPONSOR],
  };

  test("parses a valid policy", () => {
    const policy = parsePolicy(valid);
    assert.ok(ContractAddress.equals(policy.vault, ContractAddress.create(7, 0)));
    assert.equal(policy.perPaymentMax, 1_000_000n);
    assert.equal(policy.providers[0]?.provider, 10n);
    assert.deepEqual(policy.feePayers, [SPONSOR]);
  });

  test("plain http is accepted on loopback only", () => {
    const local = { ...valid, providers: [{ origin: "http://127.0.0.1:8402", provider: "10" }] };
    assert.equal(parsePolicy(local).providers[0]?.origin, "http://127.0.0.1:8402");
  });

  test("refuses invalid policies", () => {
    const bad: unknown[] = [
      null,
      [],
      { ...valid, vault: undefined },
      { ...valid, perPaymentMax: 1000000 },
      { ...valid, perPaymentMax: "0" },
      { ...valid, perPaymentMax: "4000000" },
      { ...valid, maxTimeoutSeconds: 61 },
      { ...valid, maxTimeoutSeconds: 1.5 },
      { ...valid, maxEnergy: "0" },
      { ...valid, providers: [] },
      { ...valid, providers: [{ origin: "https://seller.example/path", provider: "10" }] },
      { ...valid, providers: [{ origin: "http://seller.example", provider: "10" }] },
      { ...valid, providers: [{ origin: "https://seller.example", provider: "-1" }] },
      { ...valid, providers: [{ origin: "https://seller.example", provider: "10", payTo: "nope" }] },
      {
        ...valid,
        providers: [
          { origin: "https://seller.example", provider: "10" },
          { origin: "https://seller.example", provider: "11" },
        ],
      },
      { ...valid, feePayers: [] },
      { ...valid, feePayers: ["nope"] },
    ];
    for (const json of bad) {
      assert.throws(() => parsePolicy(json), PolicyError, JSON.stringify(json));
    }
  });
});
