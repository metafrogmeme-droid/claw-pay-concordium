import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ContractAddress, type AccountSigner } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { ephemeralAccount } from "@claw-pay-concordium/x402-vault/test-support";

import { SignRefused, createCappedSigner, type SignRefusal } from "./capped-signer.ts";
import { unsignedPay, type PayOverrides } from "./test-helpers.ts";

const NOW_MS = 1_795_350_000_000;
const VAULT = ContractAddress.create(7, 0);
const agentKey = ephemeralAccount(0x02);
const strangerKey = ephemeralAccount(0x04);

/** Counts how often the key itself is used. */
function spy(inner: AccountSigner): { signer: AccountSigner; calls: () => number } {
  let calls = 0;
  return {
    signer: {
      getSignatureCount: () => inner.getSignatureCount(),
      sign: (digest) => {
        calls += 1;
        return inner.sign(digest);
      },
    },
    calls: () => calls,
  };
}

function setup(): { sign: ReturnType<typeof createCappedSigner>; calls: () => number } {
  const key = spy(agentKey.signer);
  const sign = createCappedSigner({
    signer: key.signer,
    agent: agentKey.address,
    vault: VAULT,
    perPaymentMax: 1_000_000n,
    maxEnergy: 30_000n,
    now: () => NOW_MS,
  });
  return { sign, calls: key.calls };
}

function pay(overrides: PayOverrides = {}): Transaction.Signable {
  return unsignedPay({ agent: agentKey.address, vault: VAULT, nowMs: NOW_MS }, overrides);
}

async function refused(overrides: PayOverrides): Promise<SignRefusal[]> {
  const { sign, calls } = setup();
  const error = await sign(pay(overrides)).then(
    () => assert.fail("expected a refusal"),
    (caught: unknown) => caught,
  );
  assert.ok(error instanceof SignRefused);
  assert.equal(calls(), 0, "the key must not be used");
  return error.reasons;
}

describe("capped-signer", () => {
  test("signs a capped pay on the agent's vault, and the signature verifies", async () => {
    const { sign, calls } = setup();
    const signed = await sign(pay());
    assert.equal(calls(), 1);
    assert.ok(signed.version === 1);
    assert.equal(await Transaction.verifySignature(signed, signed.signatures.sender, agentKey.account), true);
    assert.equal(await Transaction.verifySignature(signed, signed.signatures.sender, strangerKey.account), false);
  });

  test("accepts exactly the cap and exactly 60 s", async () => {
    const { sign } = setup();
    await sign(pay({ amount: 1_000_000n, energy: 30_000n, expiryOffsetSeconds: 60 }));
  });

  test("refuses each violation without touching the key", async () => {
    const cases: [PayOverrides, SignRefusal][] = [
      [{ sponsored: false }, "not_sponsored_v1"],
      [{ sender: strangerKey.address }, "wrong_sender"],
      [{ transfer: true }, "not_contract_update"],
      [{ vault: ContractAddress.create(8, 0) }, "wrong_vault"],
      [{ entrypoint: "guard_vault.withdraw" }, "wrong_entrypoint"],
      [{ attachedMicroCcd: 1n }, "ccd_attached"],
      [{ message: new Uint8Array(55) }, "malformed_params"],
      [{ amount: 1_000_001n }, "over_per_payment"],
      [{ energy: 30_001n }, "energy_too_high"],
      [{ expiryOffsetSeconds: 0 }, "expired"],
      [{ expiryOffsetSeconds: 61 }, "expiry_too_far"],
    ];
    for (const [overrides, expected] of cases) {
      assert.deepEqual(await refused(overrides), [expected], JSON.stringify(overrides, (_k, v: unknown) => (typeof v === "bigint" ? String(v) : v)));
    }
  });

  test("lists every reason at once", async () => {
    const reasons = await refused({ vault: ContractAddress.create(8, 0), amount: 5_000_000n, energy: 99_999n });
    assert.deepEqual(reasons, ["wrong_vault", "over_per_payment", "energy_too_high"]);
  });
});
