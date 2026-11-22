import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";

import { SignRefused } from "./capped-signer.ts";
import { ConfigError, loadConfig } from "./config.ts";
import type { KeyFs } from "./keys.ts";
import { unsignedPay, walletExport } from "./test-helpers.ts";

const NOW_MS = 1_795_350_000_000;
const wallet = walletExport(0x02);

const POLICY_JSON = JSON.stringify({
  vault: { index: "7", subindex: "0" },
  perPaymentMax: "1000000",
  dailyMax: "3000000",
  maxTimeoutSeconds: 60,
  maxEnergy: "30000",
  providers: [{ origin: "https://seller.example", provider: "10" }],
});

const ENV = {
  CLAW_PAY_NETWORK: "testnet",
  CLAW_PAY_POLICY_FILE: "/operator/policy.json",
  CLAW_PAY_RECEIPT_LOG: "/operator/receipts.jsonl",
  CLAW_PAY_AGENT_KEY_FILE: "/operator/agent-key.json",
};

function deps(): { fs: KeyFs; uid: number; readPolicy: (path: string) => string; now: () => number; touched: string[] } {
  const touched: string[] = [];
  return {
    touched,
    uid: 1000,
    now: () => NOW_MS,
    readPolicy: (path) => {
      touched.push(path);
      return POLICY_JSON;
    },
    fs: {
      statSync: (path) => {
        touched.push(path);
        return { isFile: () => true, mode: 0o100600, uid: 1000 };
      },
      readFileSync: (path) => {
        touched.push(path);
        return wallet.json;
      },
    },
  };
}

describe("loadConfig", () => {
  test("refuses anything but testnet before reading any file", () => {
    for (const network of ["mainnet", undefined, "Testnet"]) {
      const d = deps();
      assert.throws(() => loadConfig({ ...ENV, CLAW_PAY_NETWORK: network }, d), /testnet only/);
      assert.deepEqual(d.touched, []);
    }
  });

  test("requires the policy and receipt log paths", () => {
    assert.throws(() => loadConfig({ ...ENV, CLAW_PAY_POLICY_FILE: undefined }, deps()), ConfigError);
    assert.throws(() => loadConfig({ ...ENV, CLAW_PAY_RECEIPT_LOG: "" }, deps()), ConfigError);
  });

  test("loads policy and key, and hands out only the capped signer", async () => {
    const config = loadConfig(ENV, deps());
    assert.equal(config.network, "testnet");
    assert.equal(config.receiptLogPath, "/operator/receipts.jsonl");
    assert.ok(AccountAddress.equals(config.agent, wallet.address));
    assert.ok(!("signer" in config));

    const defaults = { agent: wallet.address, vault: ContractAddress.create(7, 0), nowMs: NOW_MS };
    const signed = await config.sign(unsignedPay(defaults));
    assert.ok(signed.version === 1);
    assert.equal(await Transaction.verifySignature(signed, signed.signatures.sender, wallet.account), true);
    await assert.rejects(config.sign(unsignedPay({ ...defaults, vault: ContractAddress.create(8, 0) })), SignRefused);
    await assert.rejects(config.sign(unsignedPay(defaults, { amount: 1_000_001n })), SignRefused);
  });
});
