import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { SITE, buildPage } from "../build.ts";

const FIXTURE = fileURLToPath(new URL("../../../fixtures/vault-events.v1.json", import.meta.url));

describe("buildPage", () => {
  const dirs = [mkdtempSync(join(tmpdir(), "verifier-page-")), mkdtempSync(join(tmpdir(), "verifier-page-"))];
  after(() => {
    for (const dir of dirs) {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("bundles a browser-only app, deterministically, and matches the committed site", async () => {
    const [a = "", b = ""] = dirs;
    await buildPage(a);
    await buildPage(b);
    const appA = readFileSync(join(a, "app.js"));
    const appB = readFileSync(join(b, "app.js"));
    assert.ok(appA.equals(appB), "two builds are byte-identical");

    const text = appA.toString("utf8");
    assert.ok(!/(?:from|import|require\()\s*["']node:/.test(text), "no node: imports in the browser bundle");
    assert.ok(!text.includes("@grpc/grpc-js"), "no Node gRPC client in the browser bundle");
    assert.ok(appA.length < 3 * 1024 * 1024, `bundle is ${String(appA.length)} bytes`);

    assert.ok(readFileSync(join(a, "sample-events.json")).equals(readFileSync(FIXTURE)), "the sample is the golden fixture");
    assert.ok(appA.equals(readFileSync(join(SITE, "app.js"))), "site/app.js is up to date: run npm run build:page");
    assert.ok(readFileSync(join(SITE, "sample-events.json")).equals(readFileSync(FIXTURE)), "site/sample-events.json is up to date");
  });
});
