import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";

import { VAULT_ERRORS, describeRejectCode } from "./errors.ts";
import { encodeAccount, encodeBool, encodeCapsParams, encodeInitParams, encodeProviderParams, u64 } from "./params.ts";

interface Case {
  entrypoint: string;
  value: Record<string, unknown>;
  bytes: string;
}

const FIXTURE = JSON.parse(readFileSync(fileURLToPath(new URL("../../../fixtures/owner-params.v1.json", import.meta.url)), "utf8")) as {
  cases: Case[];
  errors: { code: number; name: string }[];
};

function account(hex: unknown): AccountAddress.Type {
  return AccountAddress.fromBuffer(new Uint8Array(Buffer.from(String(hex), "hex")).buffer);
}

function str(value: unknown): string {
  assert.equal(typeof value, "string");
  return value as string;
}

function encode(c: Case): Uint8Array {
  const v = c.value;
  switch (c.entrypoint) {
    case "init": {
      const registry = v["registry"] as Record<string, unknown>;
      return encodeInitParams({
        agent: account(v["agent"]),
        perTxCap: BigInt(str(v["per_tx_cap"])),
        dailyCap: BigInt(str(v["daily_cap"])),
        registry: ContractAddress.create(BigInt(str(registry["index"])), BigInt(str(registry["subindex"]))),
      });
    }
    case "set_caps":
      return encodeCapsParams({ perTxCap: BigInt(str(v["per_tx_cap"])), dailyCap: BigInt(str(v["daily_cap"])) });
    case "set_agent":
      return encodeAccount(account(v["agent"]));
    case "set_paused":
      return encodeBool(v["paused"] === true);
    case "add_provider":
      return encodeProviderParams({ tokenId: BigInt(str(v["token_id"])), cardHash: new Uint8Array(Buffer.from(str(v["card_hash"]), "hex")) });
    case "remove_provider":
    case "provider":
      return u64(BigInt(str(v["token_id"])));
    case "withdraw":
      return u64(BigInt(str(v["amount"])));
    default:
      throw new Error(`no encoder for ${c.entrypoint}`);
  }
}

describe("owner parameter encoders", () => {
  test("produce the bytes the contract serializes (fixture)", () => {
    assert.equal(FIXTURE.cases.length, 9);
    for (const c of FIXTURE.cases) {
      assert.equal(Buffer.from(encode(c)).toString("hex"), c.bytes, c.entrypoint);
    }
  });

  test("refuse values that do not fit", () => {
    assert.throws(() => u64(-1n), RangeError);
    assert.throws(() => u64(1n << 64n), RangeError);
    assert.throws(() => encodeProviderParams({ tokenId: 1n, cardHash: new Uint8Array(31) }), RangeError);
  });
});

describe("reject codes", () => {
  test("the table matches the contract's errors (fixture)", () => {
    assert.equal(VAULT_ERRORS.length, FIXTURE.errors.length);
    for (const { code, name } of FIXTURE.errors) {
      assert.equal(VAULT_ERRORS[-code - 1], name, String(code));
      assert.equal(describeRejectCode(code), `${String(code)} ${name}`);
    }
  });

  test("unknown codes are shown bare", () => {
    assert.equal(describeRejectCode(-99), "-99");
    assert.equal(describeRejectCode(5), "5");
    assert.equal(describeRejectCode(null), "no reject code");
  });
});
