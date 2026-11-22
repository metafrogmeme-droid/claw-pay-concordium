import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { LogEntry } from "@claw-pay-concordium/agent-client";
import { parseEventsFile, verify } from "@claw-pay-concordium/verifier";

import { USAGE, run, type CliDeps } from "./export-cli.ts";
import { goldenChain } from "./fake-node.ts";
import { WrongNetworkError } from "./node-client.ts";

const ARGS = ["--vault", "1,0", "--from-height", "100", "--out", "/operator/events.json"];

function deps(overrides: Partial<CliDeps> = {}): CliDeps & { written: Map<string, string>; lines: string[]; errors: string[]; connects: number } {
  const written = new Map<string, string>();
  const lines: string[] = [];
  const errors: string[] = [];
  const state = {
    written,
    lines,
    errors,
    connects: 0,
    env: { CLAW_PAY_NETWORK: "testnet", CLAW_PAY_NODE: "node.example:20000" },
    connect: () => {
      state.connects += 1;
      return Promise.resolve(goldenChain().node);
    },
    writeFile: (path: string, text: string) => {
      written.set(path, text);
    },
    readLog: (): readonly LogEntry[] => [],
    out: (line: string) => {
      lines.push(line);
    },
    err: (line: string) => {
      errors.push(line);
    },
    ...overrides,
  };
  return state;
}

describe("claw-pay-export", () => {
  test("refuses anything but testnet before connecting", async () => {
    const d = deps({ env: { CLAW_PAY_NETWORK: "mainnet" } });
    assert.equal(await run(ARGS, d), 2);
    assert.equal(d.connects, 0);
    assert.match(d.errors.join("\n"), /testnet only/);
  });

  test("refuses bad arguments with the usage line", async () => {
    for (const argv of [[], ["--vault", "1"], ["--vault", "x", "--from-height", "1", "--out", "o"], [...ARGS, "--extra", "1"], [...ARGS, "--out", "again"]]) {
      const d = deps();
      assert.equal(await run(argv, d), 2, JSON.stringify(argv));
      assert.ok(d.errors.includes(USAGE));
      assert.equal(d.connects, 0);
    }
  });

  test("writes an events file the verifier accepts", async () => {
    const d = deps();
    assert.equal(await run(ARGS, d), 0, d.errors.join("\n"));
    const text = d.written.get("/operator/events.json");
    assert.ok(text !== undefined);
    assert.equal(verify(parseEventsFile(JSON.parse(text))).ok, true);
    assert.match(d.lines[0] ?? "", /exported 13 events from finalized blocks 100\.\.110/);
  });

  test("a wrong-network node or export failure exits 2", async () => {
    const d = deps({ connect: () => Promise.reject(new WrongNetworkError("not testnet")) });
    assert.equal(await run(ARGS, d), 2);
    assert.match(d.errors.join("\n"), /export failed: not testnet/);
    assert.equal(d.written.size, 0);
  });

  test("--log reconciles and exits 1 when something needs attention", async () => {
    const d = deps();
    assert.equal(await run([...ARGS, "--log", "/operator/receipts.jsonl"], d), 1);
    assert.ok(d.lines.includes("on chain but not in the log: 4"));
  });
});
