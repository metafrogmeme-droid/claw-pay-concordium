import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { USAGE, run } from "./cli.ts";
import { CARD_PATH, REVOKED, VERIFIED, agentEntry } from "./test-fixtures.ts";

const CLI_PATH = fileURLToPath(new URL("./cli.ts", import.meta.url));

let dir: string;

before(() => {
  dir = mkdtempSync(join(tmpdir(), "claw-pay-badge-check-"));
});

after(() => {
  rmSync(dir, { recursive: true, force: true });
});

/** Write a CLI input file for a fixture agent. */
function inputFor(tokenId: number): string {
  const entry = agentEntry(tokenId);
  const path = join(dir, `agent-${String(tokenId)}.json`);
  writeFileSync(path, JSON.stringify({ token_id: entry.token_id, agent_of_reply: entry.agent_of_reply }));
  return path;
}

/** A fetcher that never touches the network. */
const offline = (): Promise<Response> => Promise.reject(new Error("network is not used in tests"));

async function capture(args: string[]): Promise<{ code: number; out: string[]; err: string[] }> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await run(
    args,
    (line) => out.push(line),
    (line) => err.push(line),
    { fetcher: offline },
  );
  return { code, out, err };
}

describe("claw-pay-badge-check", () => {
  test("an eligible agent exits 0 and prints the add_provider parameter", async () => {
    const { code, out } = await capture([inputFor(VERIFIED), "--card", CARD_PATH]);
    assert.equal(code, 0);
    assert.ok(out.some((line) => line.startsWith("ELIGIBLE")));
    assert.match(out.at(-1) ?? "", /^add_provider parameter: \{"token_id":10,"card_hash":"[0-9a-f]{64}"\}$/);
  });

  test("a revoked agent exits 1", async () => {
    const { code, out } = await capture([inputFor(REVOKED), "--card", CARD_PATH]);
    assert.equal(code, 1);
    assert.ok(out.some((line) => line.includes("not-active")));
    assert.match(out.at(-1) ?? "", /^NOT ELIGIBLE/);
  });

  test("a card that cannot be fetched is reported as unavailable", async () => {
    const { code, out } = await capture([inputFor(VERIFIED)]);
    assert.equal(code, 1);
    assert.ok(
      out.some((line) => line.includes("card-unavailable") && line.includes("not used in tests")),
      out.join("\n"),
    );
  });

  test("usage and input errors exit 2", async () => {
    assert.deepEqual(await capture([]), { code: 2, out: [], err: [USAGE] });
    assert.equal((await capture(["a.json", "b.json"])).code, 2);
    assert.equal((await capture([inputFor(VERIFIED), "--card"])).code, 2);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, JSON.stringify({ token_id: -1, agent_of_reply: "00" }));
    assert.equal((await capture([bad])).code, 2);
    assert.equal((await capture([inputFor(VERIFIED), "--card", join(dir, "missing.json")])).code, 2);
  });

  test("runs as a program", () => {
    const ok = spawnSync(process.execPath, [CLI_PATH, inputFor(VERIFIED), "--card", CARD_PATH], {
      encoding: "utf8",
    });
    assert.equal(ok.status, 0, ok.stderr);
    assert.match(ok.stdout, /ELIGIBLE/);
  });
});
