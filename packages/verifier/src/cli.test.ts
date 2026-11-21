import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { USAGE, run } from "./cli.ts";

const FIXTURE_PATH = fileURLToPath(
  new URL("../../../fixtures/vault-events.v1.json", import.meta.url),
);
const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

function capture(args: string[]): { code: number; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  const code = run(
    args,
    (line) => out.push(line),
    (line) => err.push(line),
  );
  return { code, out, err };
}

/** A copy of the fixture with one hex digit changed inside a receipt body. */
function writeTampered(dir: string): string {
  const json = JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as { events: string[] };
  const i = json.events.findIndex((event) => event.startsWith("08"));
  const event = json.events[i];
  assert.ok(event !== undefined);
  const pos = 2 + 2 * 200; // inside invoice_hash
  const digit = event[pos] === "0" ? "1" : "0";
  json.events[i] = event.slice(0, pos) + digit + event.slice(pos + 1);
  const path = join(dir, "tampered.json");
  writeFileSync(path, JSON.stringify(json));
  return path;
}

describe("claw-pay-verify", () => {
  test("verifies the golden fixture with exit code 0", () => {
    const { code, out } = capture([FIXTURE_PATH]);
    assert.equal(code, 0);
    assert.match(out.at(-1) ?? "", /^VERIFIED: 4 receipts/);
  });

  test("fails a tampered file with exit code 1", () => {
    const dir = mkdtempSync(join(tmpdir(), "claw-pay-verify-"));
    try {
      const { code, out } = capture([writeTampered(dir)]);
      assert.equal(code, 1);
      assert.ok(out.some((line) => line.includes("hash-mismatch")));
      assert.match(out.at(-1) ?? "", /^FAILED/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("usage errors and unreadable input exit with 2", () => {
    assert.deepEqual(capture([]), { code: 2, out: [], err: [USAGE] });
    assert.equal(capture(["a.json", "b.json"]).code, 2);
    const missing = capture(["/nonexistent/events.json"]);
    assert.equal(missing.code, 2);
    assert.match(missing.err[0] ?? "", /^cannot read/);
  });

  test("runs as a program", () => {
    const ok = spawnSync(process.execPath, [CLI_PATH, FIXTURE_PATH], { encoding: "utf8" });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /VERIFIED: 4 receipts/);
    const usage = spawnSync(process.execPath, [CLI_PATH], { encoding: "utf8" });
    assert.equal(usage.status, 2);
    assert.match(usage.stderr, /usage: claw-pay-verify/);
  });
});
