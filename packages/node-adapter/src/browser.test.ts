import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

const SRC = fileURLToPath(new URL(".", import.meta.url));

/** Value imports (not `import type`) of a module, as written. */
function valueImports(file: string): string[] {
  const source = readFileSync(`${SRC}${file}`, "utf8");
  return [...source.matchAll(/^(?:import|export)(?! type)[^;]*?from "([^"]+)";/gms)].map((match) => match[1] ?? "");
}

describe("browser entry", () => {
  test("nothing reachable from browser.ts imports Node-only modules", () => {
    const seen = new Set<string>();
    const queue = ["browser.ts"];
    while (queue.length > 0) {
      const file = queue.shift() ?? "";
      if (seen.has(file)) {
        continue;
      }
      seen.add(file);
      for (const specifier of valueImports(file)) {
        assert.ok(!specifier.startsWith("node:"), `${file} imports ${specifier}`);
        assert.notEqual(specifier, "@concordium/web-sdk/nodejs", `${file} imports the Node gRPC client`);
        if (specifier.startsWith("./")) {
          queue.push(specifier.slice(2));
        }
      }
    }
    assert.ok(seen.has("exporter.ts") && seen.has("testnet-guard.ts"));
    assert.ok(!seen.has("node-client.ts"));
  });
});
