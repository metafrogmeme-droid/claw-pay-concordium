import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, ContractAddress, ModuleReference } from "@concordium/web-sdk";
import { addressOf } from "@claw-pay-concordium/x402-vault/test-support";

import { encodeCapsParams, encodeProviderParams, u64 } from "./params.ts";
import { DEFAULT_INIT_ENERGY, UsageError, parseCommand, type Plan } from "./plan.ts";
import { fakeModule } from "./test-helpers.ts";

const AGENT = AccountAddress.toBase58(addressOf(0x02));
const HASH = "ab".repeat(32);

function plan(argv: string[]): Plan {
  return parseCommand(argv, () => fakeModule()).plan;
}

function update(argv: string[]): Extract<Plan, { kind: "update" }> {
  const p = plan(argv);
  assert.equal(p.kind, "update");
  return p;
}

describe("parseCommand", () => {
  test("updates carry the right entrypoint, parameter and amount", () => {
    const deposit = update(["deposit", "--vault", "7", "--amount", "5000000"]);
    assert.ok(ContractAddress.equals(deposit.vault, ContractAddress.create(7, 0)));
    assert.equal(deposit.entrypoint, "deposit");
    assert.equal(deposit.amount, 5_000_000n);
    assert.equal(deposit.parameter.length, 0);
    assert.equal(deposit.energy, undefined);

    const withdraw = update(["withdraw", "--vault", "7,1", "--amount", "10000000", "--energy", "4000"]);
    assert.ok(ContractAddress.equals(withdraw.vault, ContractAddress.create(7, 1)));
    assert.deepEqual(withdraw.parameter, u64(10_000_000n));
    assert.equal(withdraw.amount, 0n);
    assert.equal(withdraw.energy, 4000n);

    assert.deepEqual(update(["set-caps", "--vault", "7", "--per-tx-cap", "4000000", "--daily-cap", "20000000"]).parameter, encodeCapsParams({ perTxCap: 4_000_000n, dailyCap: 20_000_000n }));
    assert.deepEqual(update(["set-agent", "--vault", "7", "--agent", AGENT]).parameter, addressOf(0x02).decodedAddress);
    assert.deepEqual(update(["pause", "--vault", "7"]).parameter, new Uint8Array([1]));
    assert.deepEqual(update(["unpause", "--vault", "7"]).parameter, new Uint8Array([0]));
    assert.deepEqual(
      update(["add-provider", "--vault", "7", "--token", "10", "--card-hash", HASH]).parameter,
      encodeProviderParams({ tokenId: 10n, cardHash: new Uint8Array(32).fill(0xab) }),
    );
    assert.deepEqual(update(["remove-provider", "--vault", "7", "--token", "10"]).parameter, u64(10n));
    for (const [argv, entrypoint] of [
      [["set-caps", "--vault", "7", "--per-tx-cap", "1", "--daily-cap", "1"], "set_caps"],
      [["set-agent", "--vault", "7", "--agent", AGENT], "set_agent"],
      [["pause", "--vault", "7"], "set_paused"],
      [["add-provider", "--vault", "7", "--token", "1", "--card-hash", HASH], "add_provider"],
      [["remove-provider", "--vault", "7", "--token", "1"], "remove_provider"],
    ] as const) {
      assert.equal(update([...argv]).entrypoint, entrypoint);
    }
  });

  test("--send is parsed, anywhere", () => {
    assert.equal(parseCommand(["pause", "--vault", "7"], () => fakeModule()).send, false);
    assert.equal(parseCommand(["pause", "--send", "--vault", "7"], () => fakeModule()).send, true);
  });

  test("init: 64-byte parameter, explicit registry, default energy", () => {
    const p = plan(["init", "--module-ref", HASH, "--agent", AGENT, "--per-tx-cap", "5000000", "--daily-cap", "20000000", "--registry", "7,3"]);
    assert.equal(p.kind, "init");
    assert.equal(p.parameter.length, 64);
    assert.equal(ModuleReference.toHexString(p.moduleRef), HASH);
    assert.equal(p.energy, DEFAULT_INIT_ENERGY);
    assert.ok(p.summary.some((line) => line.includes("registry <7,3>")));
  });

  test("deploy computes the module reference from the file", () => {
    const p = plan(["deploy", "--module", "module.wasm.v1"]);
    assert.equal(p.kind, "deploy");
    assert.match(p.moduleRef, /^[0-9a-f]{64}$/);
    assert.deepEqual(p.source, fakeModule());
    const other = parseCommand(["deploy", "--module", "m"], () => fakeModule(new Uint8Array([1, 2, 3]))).plan;
    assert.ok(other.kind === "deploy" && other.moduleRef !== p.moduleRef, "the reference depends on the module bytes");
  });

  test("read-only commands", () => {
    const view = plan(["view", "--vault", "7"]);
    assert.equal(view.kind, "view");
    const provider = plan(["provider", "--vault", "7", "--token", "10"]);
    assert.ok(provider.kind === "provider" && provider.tokenId === 10n);
  });

  test("refuses bad command lines", () => {
    const bad: string[][] = [
      [],
      ["explode"],
      ["deposit", "--vault", "7"],
      ["deposit", "--vault", "7", "--amount", "0"],
      ["deposit", "--vault", "x", "--amount", "1"],
      ["deposit", "--vault", "1,2,3", "--amount", "1"],
      ["deposit", "--vault", "7", "--amount", "1", "--amount", "2"],
      ["deposit", "--vault", "7", "--amount", "1", "--token", "2"],
      ["deposit", "--vault", "7", "--amount", "1", "--energy", "0"],
      ["deposit", "--vault", "7", "--amount", "1", "--send", "--send"],
      ["set-caps", "--vault", "7", "--per-tx-cap", "5", "--daily-cap", "4"],
      ["set-agent", "--vault", "7", "--agent", "nope"],
      ["add-provider", "--vault", "7", "--token", "1", "--card-hash", HASH.toUpperCase()],
      ["add-provider", "--vault", "7", "--token", "1", "--card-hash", "abcd"],
      ["init", "--module-ref", HASH, "--agent", AGENT, "--per-tx-cap", "1", "--daily-cap", "1"],
      ["view", "--vault", "7", "--send"],
    ];
    for (const argv of bad) {
      assert.throws(() => parseCommand(argv, () => fakeModule()), UsageError, JSON.stringify(argv));
    }
    assert.throws(() => parseCommand(["deploy", "--module", "m"], () => new Uint8Array([0, 0, 0, 9])), UsageError);
  });
});
