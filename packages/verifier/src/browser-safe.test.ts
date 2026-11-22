import assert from "node:assert/strict";
import { createHash, randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { DecodeError, concatBytes, fromHex, toHex } from "./bytes.ts";
import { sha256 } from "./verify.ts";

describe("browser-safe primitives", () => {
  test("sha256 matches node:crypto", () => {
    for (let length = 0; length < 300; length += 7) {
      const bytes = new Uint8Array(randomBytes(length));
      assert.equal(toHex(sha256(bytes)), createHash("sha256").update(bytes).digest("hex"), String(length));
    }
  });

  test("hex round-trips and refuses bad input", () => {
    for (let length = 0; length < 64; length += 5) {
      const bytes = new Uint8Array(randomBytes(length));
      assert.equal(toHex(bytes), Buffer.from(bytes).toString("hex"));
      assert.deepEqual(fromHex(toHex(bytes)), bytes);
    }
    assert.deepEqual(fromHex("ABcd"), new Uint8Array([0xab, 0xcd]));
    for (const bad of ["a", "abc", "zz", "0x00", " 00"]) {
      assert.throws(() => fromHex(bad), DecodeError, bad);
    }
  });

  test("concatBytes joins in order", () => {
    assert.deepEqual(concatBytes([new Uint8Array([1]), new Uint8Array(), new Uint8Array([2, 3])]), new Uint8Array([1, 2, 3]));
  });

  test("the library (everything but the CLI) uses no Node built-ins, so it runs in a browser", () => {
    const dir = fileURLToPath(new URL(".", import.meta.url));
    const library = readdirSync(dir).filter((name) => name.endsWith(".ts") && !name.endsWith(".test.ts") && name !== "cli.ts");
    assert.ok(library.length >= 5);
    for (const name of library) {
      const source = readFileSync(`${dir}${name}`, "utf8");
      assert.ok(!/from "node:/.test(source), `${name} imports a node: module`);
      assert.ok(!/\bBuffer\b/.test(source), `${name} uses Buffer`);
    }
  });
});
