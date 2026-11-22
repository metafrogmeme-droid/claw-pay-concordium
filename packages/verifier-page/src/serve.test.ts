import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { CSP, SITE, createPageServer } from "../serve.ts";

let server: Server;
let port: number;

before(async () => {
  server = createPageServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});

after(async () => {
  await new Promise((resolve) => server.close(resolve));
});

/** A raw request, so paths like /../x reach the server unnormalized. */
function get(path: string, method = "GET"): Promise<{ status: number; headers: Record<string, string | string[] | undefined>; body: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path, method }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (chunk: string) => (body += chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("verifier page server", () => {
  test("listens on 127.0.0.1", () => {
    assert.equal((server.address() as AddressInfo).address, "127.0.0.1");
  });

  test("serves the page with the CSP, and index.html carries the same policy", async () => {
    const page = await get("/");
    assert.equal(page.status, 200);
    assert.equal(page.headers["content-security-policy"], CSP);
    assert.equal(page.headers["x-content-type-options"], "nosniff");
    assert.match(page.body, /<title>Receipt Verifier<\/title>/);
    assert.ok(readFileSync(join(SITE, "index.html"), "utf8").includes(`content="${CSP}"`));
    const app = await get("/app.js");
    assert.equal(app.status, 200);
    assert.match(String(app.headers["content-type"]), /javascript/);
  });

  test("serves nothing outside the page's own files", async () => {
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/..%2fpackage.json", "/serve.ts", "/site/index.html", "/nope"]) {
      assert.equal((await get(path)).status, 404, path);
    }
    assert.equal((await get("/", "POST")).status, 405);
  });
});
