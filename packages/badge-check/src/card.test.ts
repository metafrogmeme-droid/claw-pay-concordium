import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { after, before, describe, test } from "node:test";

import { CardFetchError, MAX_CARD_BYTES, fetchCard } from "./card.ts";
import { exampleCard } from "./test-fixtures.ts";

// A local test server on the loopback interface only. No outside network.
let server: Server;
let base: string;

before(async () => {
  server = createServer((req, res) => {
    switch (req.url) {
      case "/card":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(Buffer.from(exampleCard()));
        break;
      case "/big":
        res.writeHead(200, { "content-type": "application/json" });
        res.end(Buffer.alloc(MAX_CARD_BYTES + 1, 0x20));
        break;
      case "/big-chunked":
        res.writeHead(200, { "content-type": "application/json" });
        res.write(Buffer.alloc(MAX_CARD_BYTES, 0x20));
        res.end(Buffer.alloc(10, 0x20));
        break;
      case "/redirect":
        res.writeHead(302, { location: "/card" });
        res.end();
        break;
      case "/slow":
        // Never answers; the client's timeout must fire.
        break;
      default:
        res.writeHead(404);
        res.end();
    }
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.closeAllConnections();
  server.close();
});

describe("fetchCard", () => {
  test("returns the exact bytes", async () => {
    assert.deepEqual(await fetchCard(`${base}/card`, { allowHttp: true }), exampleCard());
  });

  test("refuses http unless allowed, and invalid URLs", async () => {
    await assert.rejects(fetchCard(`${base}/card`), /only https/);
    await assert.rejects(fetchCard("ftp://agent.example/card.json"), /only https/);
    await assert.rejects(fetchCard("not a url"), /not a valid URL/);
  });

  test("refuses cards over the size limit", async () => {
    await assert.rejects(fetchCard(`${base}/big`, { allowHttp: true }), /larger than/);
    await assert.rejects(fetchCard(`${base}/big-chunked`, { allowHttp: true }), /larger than/);
  });

  test("refuses redirects and non-200 answers", async () => {
    await assert.rejects(fetchCard(`${base}/redirect`, { allowHttp: true }), CardFetchError);
    await assert.rejects(fetchCard(`${base}/missing`, { allowHttp: true }), /HTTP 404/);
  });

  test("gives up after the timeout", async () => {
    await assert.rejects(
      fetchCard(`${base}/slow`, { allowHttp: true, timeoutMs: 200 }),
      /longer than 200 ms/,
    );
  });
});
