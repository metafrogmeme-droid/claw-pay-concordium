import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  AccountAddress,
  ContractAddress,
  Energy,
  Parameter,
  ReturnValue,
  TransactionEventTag,
  TransactionKindString,
  TransactionSummaryType,
  type BlockItemSummary,
  type InvokeContractResult,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { WrongNetworkError } from "@claw-pay-concordium/node-adapter";
import { blockHash, failedItem, fakeNode, initItem, rejectedInvoke, updateItem, type FakeNodeOptions } from "@claw-pay-concordium/node-adapter/test-support";
import { ephemeralAccount } from "@claw-pay-concordium/x402-vault/test-support";

import { energyFor, run, type OwnerCliDeps } from "./cli.ts";
import { encodeCapsParams } from "./params.ts";
import { parseCommand, type Plan } from "./plan.ts";
import { fakeModule } from "./test-helpers.ts";
import { signPlan } from "./send.ts";

const owner = ephemeralAccount(0x01);
const VAULT = ContractAddress.create(7, 0);
const ok = (used: bigint): InvokeContractResult => ({ tag: "success", usedEnergy: Energy.create(used), events: [] }) as unknown as InvokeContractResult;
const inBlock = (summary: BlockItemSummary): Promise<{ blockHash: ReturnType<typeof blockHash>; summary: BlockItemSummary }> =>
  Promise.resolve({ blockHash: blockHash(1), summary });

function deployed(moduleRef: string): BlockItemSummary {
  return {
    type: TransactionSummaryType.AccountTransaction,
    transactionType: TransactionKindString.DeployModule,
    moduleDeployed: { tag: TransactionEventTag.ModuleDeployed, contents: moduleRef },
  } as unknown as BlockItemSummary;
}

function setup(nodeOptions: FakeNodeOptions = {}, env: Record<string, string | undefined> = { CLAW_PAY_NETWORK: "testnet" }) {
  const node = fakeNode({
    invoke: ({ method }) => (method === "guard_vault.view" ? undefined : ok(1234n)),
    finalization: () => inBlock(updateItem([])),
    ...nodeOptions,
  });
  const lines: string[] = [];
  const errors: string[] = [];
  let ownerLoads = 0;
  let connects = 0;
  const deps: OwnerCliDeps = {
    env,
    loadOwner: () => {
      ownerLoads += 1;
      return { address: owner.address, signer: owner.signer };
    },
    connect: () => {
      connects += 1;
      return Promise.resolve(node);
    },
    readFile: () => fakeModule(),
    out: (line) => lines.push(line),
    err: (line) => errors.push(line),
    now: () => 1_795_350_000_000,
  };
  return { node, deps, lines, errors, counts: () => ({ ownerLoads, connects }) };
}

const STATE_CHANGING: string[][] = [
  ["deposit", "--vault", "7", "--amount", "5000000"],
  ["withdraw", "--vault", "7", "--amount", "1000000"],
  ["set-caps", "--vault", "7", "--per-tx-cap", "4000000", "--daily-cap", "20000000"],
  ["set-agent", "--vault", "7", "--agent", AccountAddress.toBase58(ephemeralAccount(0x02).address)],
  ["pause", "--vault", "7"],
  ["unpause", "--vault", "7"],
  ["add-provider", "--vault", "7", "--token", "10", "--card-hash", "ab".repeat(32)],
  ["remove-provider", "--vault", "7", "--token", "10"],
];

describe("claw-pay-owner guards", () => {
  test("refuses anything but testnet before loading the key or connecting", async () => {
    const s = setup({}, { CLAW_PAY_NETWORK: "mainnet" });
    assert.equal(await run(["pause", "--vault", "7", "--send"], s.deps), 2);
    assert.deepEqual(s.counts(), { ownerLoads: 0, connects: 0 });
  });

  test("a bad command line exits 2 with the usage", async () => {
    const s = setup();
    assert.equal(await run(["pause"], s.deps), 2);
    assert.ok(s.errors.some((line) => line.startsWith("usage: claw-pay-owner")));
    assert.equal(s.counts().connects, 0);
  });

  test("a wrong-network node exits 2", async () => {
    const s = setup();
    s.deps.connect = () => Promise.reject(new WrongNetworkError("not testnet"));
    assert.equal(await run(["pause", "--vault", "7", "--send"], s.deps), 2);
    assert.match(s.errors.join("\n"), /not testnet/);
  });
});

describe("dry run unless --send", () => {
  test("every state-changing command dry-runs as the owner and sends nothing", async () => {
    for (const argv of STATE_CHANGING) {
      const invoked: { invoker: AccountAddress.Type | undefined; amount: bigint; method: string }[] = [];
      const s = setup({
        invoke: (call) => {
          invoked.push(call);
          return ok(1234n);
        },
      });
      assert.equal(await run(argv, s.deps), 0, `${argv.join(" ")}: ${s.errors.join("; ")}`);
      assert.equal(s.node.sent.length, 0, argv[0]);
      assert.ok(s.lines.some((line) => line.startsWith("dry run only")), argv[0]);
      assert.equal(invoked.length, 1);
      const call = invoked[0];
      assert.ok(call?.invoker !== undefined && AccountAddress.equals(call.invoker, owner.address));
      assert.equal(call.amount, argv[0] === "deposit" ? 5_000_000n : 0n);
    }
  });

  test("--send submits one signed transaction with the planned fields", async () => {
    const s = setup();
    const argv = ["set-caps", "--vault", "7", "--per-tx-cap", "4000000", "--daily-cap", "20000000", "--send"];
    assert.equal(await run(argv, s.deps), 0, s.errors.join("; "));
    assert.equal(s.node.sent.length, 1);
    const sent = s.node.sent[0];
    assert.ok(sent !== undefined);
    assert.ok(AccountAddress.equals(sent.header.sender, owner.address));
    assert.ok(s.lines.includes(`dry run ok: used 1234 energy; would send with ${String(energyFor(1234n))}`));
    const payload = sent.payload;
    assert.ok("receiveName" in payload && "message" in payload && "address" in payload);
    assert.equal(payload.receiveName.toString(), "guard_vault.set_caps");
    assert.ok(ContractAddress.equals(payload.address, VAULT));
    assert.deepEqual(Parameter.toBuffer(payload.message), encodeCapsParams({ perTxCap: 4_000_000n, dailyCap: 20_000_000n }));
    assert.ok(s.lines.includes("finalized: ok"));
  });

  test("deposit attaches the amount", async () => {
    const s = setup();
    assert.equal(await run(["deposit", "--vault", "7", "--amount", "5000000", "--send"], s.deps), 0);
    const payload = s.node.sent[0]?.payload;
    assert.ok(payload !== undefined && "amount" in payload);
    assert.equal(payload.amount.microCcdAmount, 5_000_000n);
  });

  test("the owner's signature verifies", async () => {
    const plan = parseCommand(["pause", "--vault", "7"], () => fakeModule()).plan as Extract<Plan, { kind: "update" }>;
    const signed = await signPlan({ address: owner.address, signer: owner.signer }, plan, { nonce: 3n, energy: 5000n, nowMs: Date.now() });
    assert.ok(signed.version === 0);
    assert.equal(signed.header.executionEnergyAmount.value, 5000n);
    assert.equal(await Transaction.verifySignature(signed, signed.signature, owner.account), true);
    assert.equal(await Transaction.verifySignature(signed, signed.signature, ephemeralAccount(0x01).account), false);
  });

  test("a rejected dry run is never sent, and names the reject code", async () => {
    const s = setup({ invoke: () => rejectedInvoke(-2) });
    assert.equal(await run(["pause", "--vault", "7", "--send"], s.deps), 1);
    assert.equal(s.node.sent.length, 0);
    assert.match(s.errors.join("\n"), /dry run rejected: -2 NotOwner; nothing was sent/);
  });

  test("an on-chain rejection exits 1 with the code and its name", async () => {
    const s = setup({ finalization: () => inBlock(failedItem(-11)) });
    assert.equal(await run(["pause", "--vault", "7", "--send"], s.deps), 1);
    assert.match(s.errors.join("\n"), /\(-11 ExceedsDailyCap\)/);
  });

  test("a finalization timeout exits 1 and says where to look", async () => {
    const s = setup({ finalization: () => Promise.reject(new Error("Function timed out.")) });
    assert.equal(await run(["pause", "--vault", "7", "--send"], s.deps), 1);
    assert.match(s.errors.join("\n"), /not finalized in time/);
  });
});

describe("deploy and init", () => {
  const expected = parseCommand(["deploy", "--module", "m"], () => fakeModule()).plan;
  const moduleRef = expected.kind === "deploy" ? expected.moduleRef : "";

  test("deploy dry run prints the module reference and sends nothing", async () => {
    const s = setup();
    assert.equal(await run(["deploy", "--module", "module.wasm.v1"], s.deps), 0);
    assert.ok(s.lines.some((line) => line.includes(moduleRef)));
    assert.equal(s.node.sent.length, 0);
  });

  test("deploy --send requires the chain's module reference to match", async () => {
    const good = setup({ finalization: () => inBlock(deployed(moduleRef)) });
    assert.equal(await run(["deploy", "--module", "m", "--send"], good.deps), 0, good.errors.join("; "));
    assert.ok(good.lines.includes(`deployed module ${moduleRef}`));
    const bad = setup({ finalization: () => inBlock(deployed("00".repeat(32))) });
    assert.equal(await run(["deploy", "--module", "m", "--send"], bad.deps), 1);
    assert.match(bad.errors.join("\n"), /not the expected/);
  });

  test("init dry run sends nothing; --send reports the new vault", async () => {
    const argv = ["init", "--module-ref", moduleRef, "--agent", AccountAddress.toBase58(ephemeralAccount(0x02).address), "--per-tx-cap", "5000000", "--daily-cap", "20000000", "--registry", "7,3"];
    const dry = setup();
    assert.equal(await run(argv, dry.deps), 0);
    assert.equal(dry.node.sent.length, 0);
    const live = setup({ finalization: () => inBlock(initItem(ContractAddress.create(42, 0), [])) });
    assert.equal(await run([...argv, "--send"], live.deps), 0, live.errors.join("; "));
    assert.ok(live.lines.includes("vault created at <42,0>"));
  });
});

describe("read-only commands", () => {
  test("view prints the vault without loading the key or sending", async () => {
    const s = setup();
    assert.equal(await run(["view", "--vault", "7"], s.deps), 0, s.errors.join("; "));
    assert.equal(s.counts().ownerLoads, 0);
    assert.equal(s.node.sent.length, 0);
    assert.ok(s.lines.some((line) => line.includes("next nonce   4")));
  });

  test("provider shows the approved card hash, or that it is not allowlisted", async () => {
    const reply = (bytes: number[]): InvokeContractResult =>
      ({ tag: "success", usedEnergy: Energy.create(1n), events: [], returnValue: ReturnValue.fromBuffer(new Uint8Array(bytes).buffer) }) as unknown as InvokeContractResult;
    const listed = setup({ invoke: () => reply([1, ...new Array<number>(32).fill(0xab)]) });
    assert.equal(await run(["provider", "--vault", "7", "--token", "10"], listed.deps), 0);
    assert.ok(listed.lines[0]?.includes(`card hash ${"ab".repeat(32)}`));
    const unlisted = setup({ invoke: () => reply([0]) });
    assert.equal(await run(["provider", "--vault", "7", "--token", "10"], unlisted.deps), 0);
    assert.ok(unlisted.lines[0]?.includes("not allowlisted"));
  });
});
