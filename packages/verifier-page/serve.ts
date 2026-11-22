/**
 * Serve the verifier page locally, on 127.0.0.1 only. Only the page's own
 * files are served; anything else is a 404.
 *
 *   npm run serve:page            (http://127.0.0.1:8080)
 *   npm run serve:page -- 9000
 */

import { readFileSync, realpathSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SITE = join(HERE, "site");

/**
 * The page's Content-Security-Policy; index.html carries the same one.
 * `'wasm-unsafe-eval'` lets the web-sdk compile its bundled Rust bindings
 * (WebAssembly, same origin); it does not allow JavaScript eval.
 */
export const CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; connect-src 'self' https: http://localhost:* http://127.0.0.1:*; img-src 'self' data:; base-uri 'none'; form-action 'none'";

const FILES: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/style.css": { file: "style.css", type: "text/css; charset=utf-8" },
  "/sample-events.json": { file: "sample-events.json", type: "application/json" },
};

export function createPageServer(siteDir: string = SITE): Server {
  return createServer((request, response) => {
    const headers = { "Content-Security-Policy": CSP, "X-Content-Type-Options": "nosniff", "Referrer-Policy": "no-referrer" };
    if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, headers).end();
      return;
    }
    let path: string;
    try {
      path = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    } catch {
      response.writeHead(400, headers).end();
      return;
    }
    const entry = Object.hasOwn(FILES, path) ? FILES[path] : undefined;
    if (entry === undefined) {
      response.writeHead(404, headers).end();
      return;
    }
    let body: Buffer;
    try {
      body = readFileSync(join(siteDir, entry.file));
    } catch {
      response.writeHead(404, headers).end();
      return;
    }
    response.writeHead(200, { ...headers, "Content-Type": entry.type, "Cache-Control": "no-store" });
    response.end(request.method === "HEAD" ? undefined : body);
  });
}

function isMain(): boolean {
  const entry = process.argv[1];
  try {
    return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  const port = Number(process.argv[2] ?? "8080");
  createPageServer().listen(port, "127.0.0.1", () => {
    console.log(`verifier page on http://127.0.0.1:${String(port)} (Ctrl-C to stop)`);
  });
}
