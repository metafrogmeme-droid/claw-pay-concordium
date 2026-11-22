import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress, Parameter, type AccountInfo } from "@concordium/web-sdk";
import type { Transaction } from "@concordium/web-sdk/transactions";
import { MemoryLogStore, ReceiptLog, createCappedSigner, loadConfig, type ClientConfig } from "@claw-pay-concordium/agent-client";
import { blockHash, fakeNode, rejectedInvoke, successInvoke, updateItem, updated, viewBytes } from "@claw-pay-concordium/node-adapter/test-support";
import { addressOf, ephemeralAccount, receiptEventFor } from "@claw-pay-concordium/x402-vault/test-support";

import { runAgent, type AgentDeps } from "./agent-cli.ts";
import { startSeller, type RunningSeller, type SellerDeps } from "./seller-cli.ts";

const VAULT = ContractAddress.create(1, 0);
const SELLER = addressOf(0x03);
const agentKey = ephemeralAccount(0x02);
const sponsorKey = ephemeralAccount(0x09);

const SELLER_CONFIG = {
  listen: { host: "127.0.0.1", port: 0 },
  provider: "10",
  payTo: AccountAddress.toBase58(SELLER),
  vaults: ["1,0"],
  maxEnergy: "50000",
  routes: [
    { path: "/weather", price: "1000000", contentType: "application/json", body: '{"forecast":"sunny"}' },
    { path: "/premium", price: "5000000", contentType: "text/plain", body: "premium" },
  ],
};

function messageOf(sent: Transaction.Finalized): Uint8Array {
  const payload = sent.payload;
  assert.ok("message" in payload);
  return Parameter.toBuffer(payload.message);
}

/** One fake testnet shared by the agent and the seller. */
function chain(options: { paused?: boolean } = {}): ReturnType<typeof fakeNode> {
  return fakeNode({
    accounts: new Map([[AccountAddress.toBase58(agentKey.address), agentKey.account as unknown as AccountInfo]]),
    // An explicit day and spend, so the vault spend floor does not depend on today's date.
    views: new Map([["latest", viewBytes({ agent: agentKey.address, nextNonce: 0n, currentDay: 0n, spentToday: 0n })]]),
    pay: (invoker, message) =>
      options.paused === true ? rejectedInvoke(-6) : successInvoke([updated(VAULT, [receiptEventFor(VAULT, invoker ?? agentKey.address, message, SELLER)])]),
    finalization: (sent) =>
      Promise.resolve({ blockHash: blockHash(1), summary: updateItem([updated(VAULT, [receiptEventFor(VAULT, agentKey.address, messageOf(sent), SELLER)])]) }),
  });
}

function sellerDeps(node: ReturnType<typeof fakeNode>, env: Record<string, string | undefined> = { CLAW_PAY_NETWORK: "testnet", CLAW_PAY_SELLER_CONFIG: "/operator/seller.json" }): SellerDeps & { lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    env,
    readConfig: () => JSON.stringify(SELLER_CONFIG),
    loadSponsor: () => ({ address: sponsorKey.address, signer: sponsorKey.signer }),
    connect: () => Promise.resolve(node),
    out: (line) => lines.push(line),
  };
}

function agentDeps(node: ReturnType<typeof fakeNode>, seller: RunningSeller): AgentDeps & { lines: string[]; errors: string[]; log: ReceiptLog } {
  const log = ReceiptLog.open(new MemoryLogStore());
  const lines: string[] = [];
  const errors: string[] = [];
  const config: ClientConfig = {
    network: "testnet",
    policy: {
      vault: VAULT,
      perPaymentMax: 2_000_000n,
      dailyMax: 10_000_000n,
      maxTimeoutSeconds: 60,
      maxEnergy: 30_000n,
      providers: [{ origin: new URL(seller.url).origin, provider: 10n, payTo: AccountAddress.toBase58(SELLER) }],
    },
    receiptLogPath: "/operator/receipts.jsonl",
    agent: agentKey.address,
    sign: createCappedSigner({ signer: agentKey.signer, agent: agentKey.address, vault: VAULT, perPaymentMax: 2_000_000n, maxEnergy: 30_000n }),
  };
  return {
    log,
    lines,
    errors,
    env: { CLAW_PAY_NETWORK: "testnet" },
    loadConfig: () => config,
    connect: () => Promise.resolve(node),
    openLog: () => log,
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
  };
}

function payCalls(node: ReturnType<typeof fakeNode>): number {
  return node.calls.filter((call) => call === "invokeContract:guard_vault.pay").length;
}

describe("end-to-end demo rehearsal (offline)", () => {
  test("the agent pays the seller through the vault and gets the resource", async () => {
    const node = chain();
    const seller = await startSeller(sellerDeps(node));
    try {
      const agent = agentDeps(node, seller);
      const code = await runAgent([`${seller.url}/weather`], agent);
      assert.equal(code, 0, agent.errors.join("; "));
      assert.equal(agent.lines[0], "HTTP 200");
      assert.ok(agent.lines.includes('{"forecast":"sunny"}'));
      assert.deepEqual(agent.log.entries.map((entry) => entry.kind), ["attempt", "settled"]);
      assert.equal(agent.log.entries[1]?.transaction, "ab".repeat(32));
      assert.equal(node.sent.length, 1, "one sponsored transaction submitted");
      assert.equal(payCalls(node), 1, "one dry run by the facilitator");
    } finally {
      await seller.close();
    }
  });

  test("an offer over the agent's cap is refused, and the seller never sees a payment", async () => {
    const node = chain();
    const seller = await startSeller(sellerDeps(node));
    try {
      const agent = agentDeps(node, seller);
      assert.equal(await runAgent([`${seller.url}/premium`], agent), 1);
      assert.match(agent.errors.join("\n"), /payment refused by spend-policy: over_per_payment/);
      assert.equal(payCalls(node), 0);
      assert.equal(agent.log.entries.length, 0);
    } finally {
      await seller.close();
    }
  });

  test("a paused vault fails the facilitator's dry run: logged as failed, nothing submitted", async () => {
    const node = chain({ paused: true });
    const seller = await startSeller(sellerDeps(node));
    try {
      const agent = agentDeps(node, seller);
      assert.equal(await runAgent([`${seller.url}/weather`], agent), 1);
      assert.equal(agent.lines[0], "HTTP 402");
      assert.deepEqual(agent.log.entries.map((entry) => [entry.kind, entry.errorReason]), [
        ["attempt", undefined],
        ["failed", "dry_run_rejected"],
      ]);
      assert.equal(node.sent.length, 0);
    } finally {
      await seller.close();
    }
  });
});

describe("claw-pay-seller", () => {
  test("refuses anything but testnet before loading the key or connecting", async () => {
    let touched = 0;
    const deps = sellerDeps(chain(), { CLAW_PAY_NETWORK: "mainnet", CLAW_PAY_SELLER_CONFIG: "/x" });
    deps.loadSponsor = () => {
      touched += 1;
      return { address: sponsorKey.address, signer: sponsorKey.signer };
    };
    await assert.rejects(startSeller(deps), /testnet only/);
    assert.equal(touched, 0);
  });

  test("a missing or invalid config is refused before listening", async () => {
    await assert.rejects(startSeller(sellerDeps(chain(), { CLAW_PAY_NETWORK: "testnet" })), /CLAW_PAY_SELLER_CONFIG is not set/);
    const broken = sellerDeps(chain());
    broken.readConfig = () => "{ not json";
    await assert.rejects(startSeller(broken), /could not be read as JSON/);
    const exposed = sellerDeps(chain());
    exposed.readConfig = () => JSON.stringify({ ...SELLER_CONFIG, listen: { host: "0.0.0.0", port: 0 } });
    // If it ever started, close it again rather than leave it listening.
    const outcome = await startSeller(exposed).then(
      async (seller) => {
        await seller.close();
        return new Error("the seller started");
      },
      (error: unknown) => error,
    );
    assert.ok(outcome instanceof Error);
    assert.match(outcome.message, /listen\.host must be loopback/);
  });

  test("starts on loopback, serves /health, prints its routes, and closes", async () => {
    const deps = sellerDeps(chain());
    const seller = await startSeller(deps);
    try {
      assert.match(seller.url, /^http:\/\/127\.0\.0\.1:\d+$/);
      assert.equal((await fetch(`${seller.url}/health`)).status, 200);
      assert.equal(seller.sponsor, AccountAddress.toBase58(sponsorKey.address));
      assert.ok(deps.lines.some((line) => line.includes("/weather") && line.includes("1.000000 CCD")));
    } finally {
      await seller.close();
    }
  });
});

describe("claw-pay-agent", () => {
  test("refuses anything but testnet before connecting", async () => {
    let connects = 0;
    const code = await runAgent(["http://127.0.0.1:1/x"], {
      env: { CLAW_PAY_NETWORK: "mainnet" },
      loadConfig: (env) => loadConfig(env),
      connect: () => {
        connects += 1;
        return Promise.reject(new Error("must not connect"));
      },
      openLog: () => ReceiptLog.open(new MemoryLogStore()),
      out: () => undefined,
      err: () => undefined,
    });
    assert.equal(code, 2);
    assert.equal(connects, 0);
  });

  test("a bad command line exits 2 with the usage", async () => {
    for (const argv of [[], ["not a url"], ["http://127.0.0.1/a", "extra"]]) {
      const errors: string[] = [];
      const code = await runAgent(argv, {
        env: {},
        loadConfig: () => assert.fail("must not load config"),
        connect: () => assert.fail("must not connect"),
        openLog: () => assert.fail("must not open the log"),
        out: () => undefined,
        err: (line) => errors.push(line),
      });
      assert.equal(code, 2, JSON.stringify(argv));
      assert.deepEqual(errors, ["usage: claw-pay-agent <url>"]);
    }
  });
});
