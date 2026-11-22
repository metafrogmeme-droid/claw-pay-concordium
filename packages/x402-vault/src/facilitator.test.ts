import assert from "node:assert/strict";
import { beforeEach, describe, test } from "node:test";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import type { FinalizationResult } from "./chain.ts";
import { VaultExactFacilitator } from "./facilitator.ts";
import { CONCORDIUM_TESTNET, newRequirements } from "./scheme.ts";
import {
  FakeChain,
  addressOf,
  ephemeralAccount,
  paymentFor,
  receiptEventFor,
  type TxOverrides,
} from "./test-support.ts";

const NOW_MS = 1_795_350_000_000;
const VAULT = ContractAddress.create(7, 0);
const OTHER_VAULT = ContractAddress.create(8, 0);
const SELLER = addressOf(0x03);

// Fresh in-memory keys for this run only.
const agentKey = ephemeralAccount(0x02);
const strangerKey = ephemeralAccount(0x04);
const sponsorKey = ephemeralAccount(0x09);

let chain: FakeChain;
let facilitator: VaultExactFacilitator;
let requirements: PaymentRequirements;

beforeEach(() => {
  chain = new FakeChain(VAULT, agentKey.address, SELLER);
  chain.addAccount(agentKey);
  chain.addAccount(strangerKey);
  chain.addAccount(sponsorKey);
  facilitator = new VaultExactFacilitator({
    network: CONCORDIUM_TESTNET,
    sponsor: { address: sponsorKey.address, signer: sponsorKey.signer },
    vaults: [VAULT],
    maxEnergy: 50_000n,
    chain,
    now: () => NOW_MS,
  });
  requirements = newRequirements({
    network: CONCORDIUM_TESTNET,
    amount: 1_000_000n,
    payTo: AccountAddress.toBase58(SELLER),
    feePayer: AccountAddress.toBase58(sponsorKey.address),
    provider: 10n,
  });
});

function pay(overrides: TxOverrides = {}): Promise<PaymentPayload> {
  return paymentFor(requirements, { vault: VAULT, agent: agentKey, nowMs: NOW_MS }, overrides);
}

async function reason(payload: PaymentPayload, req = requirements): Promise<string | undefined> {
  const result = await facilitator.verify(payload, req);
  assert.equal(result.isValid, false, "expected an invalid payment");
  return result.invalidReason;
}

describe("verify", () => {
  test("accepts a correct payment from the vault's agent", async () => {
    const result = await facilitator.verify(await pay(), requirements);
    assert.deepEqual(result, { isValid: true, payer: AccountAddress.toBase58(agentKey.address) });
  });

  test("advertises the sponsor as fee payer", () => {
    const sponsor = AccountAddress.toBase58(sponsorKey.address);
    assert.deepEqual(facilitator.getExtra(CONCORDIUM_TESTNET), { feePayer: sponsor });
    assert.deepEqual(facilitator.getSigners(CONCORDIUM_TESTNET), [sponsor]);
    assert.equal(facilitator.getExtra("ccd:00000000000000000000000000000000"), undefined);
  });

  test("rule 1: the transaction must parse", async () => {
    const payload = await pay();
    payload.payload = { signedTransaction: { version: 1 } };
    assert.equal(await reason(payload), "invalid_transaction_format");
  });

  test("rule 2: only pay on a configured vault, no CCD, capped energy", async () => {
    assert.equal(await reason(await pay({ vault: OTHER_VAULT })), "vault_not_allowed");
    assert.equal(await reason(await pay({ entrypoint: "guard_vault.withdraw" })), "wrong_entrypoint");
    assert.equal(await reason(await pay({ attachedMicroCcd: 1n })), "nonzero_amount");
    assert.equal(await reason(await pay({ energy: 50_001n })), "energy_too_high");
  });

  test("rules 3 and 4: the parameter must be this offer's PayParams", async () => {
    assert.equal(await reason(await pay({ message: new Uint8Array(55) })), "invalid_pay_params");
    assert.equal(await reason(await pay({ provider: 11n })), "provider_mismatch");
    assert.equal(await reason(await pay({ amount: 999_999n })), "amount_mismatch");
    assert.equal(await reason(await pay({ invoiceHash: new Uint8Array(32) })), "invoice_mismatch");
  });

  test("rule 5: sponsored by this facilitator, never by the sender", async () => {
    assert.equal(await reason(await pay({ sponsor: strangerKey.address })), "sponsor_mismatch");
    const foreignFeePayer = {
      ...requirements,
      extra: { ...requirements.extra, feePayer: AccountAddress.toBase58(strangerKey.address) },
    };
    assert.equal(await reason(await pay(), foreignFeePayer), "sponsor_mismatch");
    const selfSponsored = await pay({ sender: sponsorKey.address, signer: sponsorKey.signer });
    assert.equal(await reason(selfSponsored), "sender_is_sponsor");
  });

  test("rule 6: expiry in the future and within 60 s", async () => {
    assert.equal(await reason(await pay({ expiryOffsetSeconds: 0 })), "expired");
    assert.equal(await reason(await pay({ expiryOffsetSeconds: 61 })), "expiry_too_far");
  });

  test("rule 7: the sender's signature must verify", async () => {
    // Claims to be the agent but is signed with a stranger's key.
    assert.equal(await reason(await pay({ signer: strangerKey.signer })), "invalid_sender_signature");
  });

  test("rule 8: the sender must be the vault's agent", async () => {
    const payload = await pay({ sender: strangerKey.address, signer: strangerKey.signer });
    assert.equal(await reason(payload), "sender_not_agent");
  });

  test("rule 9: the dry run must succeed with the expected receipt", async () => {
    chain.dryRun = () => ({ ok: false, rejectCode: -11, message: "ExceedsDailyCap" });
    const rejected = await facilitator.verify(await pay(), requirements);
    assert.equal(rejected.invalidReason, "dry_run_rejected");
    assert.match(rejected.invalidMessage ?? "", /reject code -11/);

    chain.dryRun = (message) => ({
      ok: true,
      events: [receiptEventFor(VAULT, agentKey.address, message, strangerKey.address)],
    });
    assert.equal(await reason(await pay()), "dry_run_receipt_mismatch");

    chain.dryRun = () => ({ ok: true, events: [] });
    assert.equal(await reason(await pay()), "dry_run_receipt_mismatch");
  });

  test("rule 10: one payment in flight per sender", async () => {
    let finish: (result: FinalizationResult) => void = () => undefined;
    chain.finalization = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const payload = await pay();
    const settling = facilitator.settle(payload, requirements);
    await new Promise((resolve) => setImmediate(resolve));

    assert.equal(await reason(await pay()), "payment_in_flight");
    const second = await facilitator.settle(await pay(), requirements);
    assert.equal(second.errorReason, "payment_in_flight");

    finish({ status: "timeout" });
    await settling;
    const after = await facilitator.verify(await pay(), requirements);
    assert.equal(after.isValid, true, "the lock is released after settle");
  });

  test("requirements for another network or a bad offer are refused", async () => {
    const otherNetwork = { ...requirements, network: "ccd:00000000000000000000000000000000" as const };
    assert.equal(await reason(await pay(), otherNetwork), "unsupported_network");
    assert.equal(await reason(await pay(), { ...requirements, amount: "0" }), "invalid_requirements");
  });
});

describe("settle", () => {
  test("co-signs, submits and confirms the receipt", async () => {
    const result = await facilitator.settle(await pay(), requirements);
    assert.equal(result.success, true, result.errorMessage);
    assert.equal(result.transaction, "ab".repeat(32));
    assert.equal(result.payer, AccountAddress.toBase58(agentKey.address));
    assert.equal(result.amount, "1000000");
    assert.equal(chain.submitted.length, 1);
    const submitted = chain.submitted[0];
    assert.ok(submitted?.version === 1);
    assert.ok(Object.keys(submitted.signatures.sponsor ?? {}).length > 0, "sponsor signature added");
  });

  test("an invalid payment is never submitted", async () => {
    const result = await facilitator.settle(await pay({ amount: 1n }), requirements);
    assert.equal(result.success, false);
    assert.equal(result.errorReason, "amount_mismatch");
    assert.equal(chain.submitted.length, 0);
  });

  test("timeout, rejection or a wrong receipt is a failure, and the lock is released", async () => {
    const outcomes: [FinalizationResult, string][] = [
      [{ status: "timeout" }, "finalization_timeout"],
      [{ status: "finalized", success: false, rejectCode: -6, message: "Paused" }, "transaction_rejected"],
      [{ status: "finalized", success: true, events: [] }, "receipt_mismatch"],
    ];
    for (const [outcome, expected] of outcomes) {
      chain.finalization = () => Promise.resolve(outcome);
      const result = await facilitator.settle(await pay(), requirements);
      assert.equal(result.success, false);
      assert.equal(result.errorReason, expected);
      assert.equal((await facilitator.verify(await pay(), requirements)).isValid, true);
    }
  });
});
