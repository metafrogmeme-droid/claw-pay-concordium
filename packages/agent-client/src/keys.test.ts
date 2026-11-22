import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";

import { ContractAddress, AccountAddress } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";

import { KeyFileError, loadAgentKey, loadKeyFile, type KeyFs } from "./keys.ts";
import { unsignedPay, walletExport } from "./test-helpers.ts";

const UID = 1000;
const PATH = "/operator/agent-key.json";
const ENV = { CLAW_PAY_AGENT_KEY_FILE: PATH };

/** An in-memory file system holding one file. Nothing touches disk. */
function fakeFs(content: string, options: { mode?: number; uid?: number; isFile?: boolean } = {}): KeyFs & { reads: number } {
  const fs = {
    reads: 0,
    statSync: (path: string) => {
      if (path !== PATH) {
        throw new Error("ENOENT");
      }
      return { isFile: () => options.isFile ?? true, mode: 0o100000 | (options.mode ?? 0o600), uid: options.uid ?? UID };
    },
    readFileSync: (path: string) => {
      if (path !== PATH) {
        throw new Error("ENOENT");
      }
      fs.reads += 1;
      return content;
    },
  };
  return fs;
}

function loadError(env: Record<string, string | undefined>, fs: KeyFs): KeyFileError {
  try {
    loadAgentKey(env, { fs, uid: UID });
  } catch (error) {
    assert.ok(error instanceof KeyFileError, String(error));
    return error;
  }
  return assert.fail("expected a KeyFileError");
}

describe("loadAgentKey", () => {
  test("loads a mode-600 testnet wallet export, and its signer signs as the agent", async () => {
    const wallet = walletExport(0x02);
    const key = loadAgentKey(ENV, { fs: fakeFs(wallet.json), uid: UID });
    assert.ok(AccountAddress.equals(key.address, wallet.address));
    const transaction = unsignedPay({ agent: key.address, vault: ContractAddress.create(7, 0), nowMs: Date.now() });
    const signed = await Transaction.sign(transaction, key.signer);
    assert.ok(signed.version === 1);
    assert.equal(await Transaction.verifySignature(signed, signed.signatures.sender, wallet.account), true);
  });

  test("mode 400 is fine too", () => {
    loadAgentKey(ENV, { fs: fakeFs(walletExport(0x02).json, { mode: 0o400 }), uid: UID });
  });

  test("refuses group or other permissions before reading the file", () => {
    for (const mode of [0o644, 0o640, 0o604, 0o660, 0o601]) {
      const fs = fakeFs(walletExport(0x02).json, { mode });
      const error = loadError(ENV, fs);
      assert.match(error.message, new RegExp(`mode ${mode.toString(8)}`));
      assert.equal(fs.reads, 0, "must not read an exposed key file");
    }
  });

  test("refuses a missing variable, a missing file, a non-file or another owner", () => {
    const json = walletExport(0x02).json;
    assert.match(loadError({}, fakeFs(json)).message, /not set/);
    assert.match(loadError({ CLAW_PAY_AGENT_KEY_FILE: "/elsewhere" }, fakeFs(json)).message, /readable file/);
    assert.match(loadError(ENV, fakeFs(json, { isFile: false })).message, /regular file/);
    assert.match(loadError(ENV, fakeFs(json, { uid: 0 })).message, /owned by/);
  });

  test("refuses a mainnet export", () => {
    assert.match(loadError(ENV, fakeFs(walletExport(0x02, "mainnet").json)).message, /not a testnet wallet export/);
  });

  test("refuses malformed content without echoing it", () => {
    const marker = "do-not-echo-this-content";
    for (const content of [marker, `{"type":"${marker}"}`, JSON.stringify({ type: "t", v: 0, environment: "testnet", value: { address: marker, credentials: {}, accountKeys: {} } })]) {
      const error = loadError(ENV, fakeFs(content));
      assert.match(error.message, /not a Concordium wallet export/);
      assert.ok(!error.message.includes(marker));
    }
  });
});

describe("loadKeyFile", () => {
  test("applies the same rules under another variable, and names it in errors", () => {
    const wallet = walletExport(0x06);
    const env = { CLAW_PAY_OWNER_KEY_FILE: PATH };
    const key = loadKeyFile(env, "CLAW_PAY_OWNER_KEY_FILE", { fs: fakeFs(wallet.json), uid: UID });
    assert.ok(AccountAddress.equals(key.address, wallet.address));
    assert.throws(() => loadKeyFile({}, "CLAW_PAY_OWNER_KEY_FILE", { fs: fakeFs(wallet.json), uid: UID }), /CLAW_PAY_OWNER_KEY_FILE is not set/);
    assert.throws(() => loadKeyFile(env, "CLAW_PAY_OWNER_KEY_FILE", { fs: fakeFs(wallet.json, { mode: 0o640 }), uid: UID }), /must be 600/);
    assert.throws(() => loadKeyFile(env, "CLAW_PAY_OWNER_KEY_FILE", { fs: fakeFs(walletExport(0x06, "mainnet").json), uid: UID }), /not a testnet wallet export/);
  });
});

describe("loadAgentKey on a real file system", () => {
  // A dummy that is not a key: only the permission check is exercised here.
  const dir = mkdtempSync(join(tmpdir(), "claw-pay-keys-"));
  const path = join(dir, "not-a-key.json");
  writeFileSync(path, "{}", { mode: 0o644 });
  after(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("644 is refused, 600 passes the permission check", () => {
    const env = { CLAW_PAY_AGENT_KEY_FILE: path };
    chmodSync(path, 0o644);
    assert.throws(() => loadAgentKey(env), /must be 600/);
    chmodSync(path, 0o600);
    assert.throws(() => loadAgentKey(env), /not a Concordium wallet export/);
  });
});
