import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { decodeAgentView } from "./agent-view.ts";
import { checkBadge, type BadgeReport } from "./badge.ts";
import { NO_WALLET, REVOKED, VERIFIED, agentReply, exampleCard } from "./test-fixtures.ts";

function codes(report: BadgeReport): string[] {
  return report.issues.map((issue) => issue.code).sort();
}

describe("checkBadge", () => {
  test("an Active agent whose card matches and has a wallet is eligible", () => {
    const report = checkBadge({
      tokenId: 10n,
      view: decodeAgentView(agentReply(VERIFIED)),
      cardBytes: exampleCard(),
    });
    assert.deepEqual(report.issues, []);
    assert.equal(report.verified, true);
    assert.equal(report.eligible, true);
    assert.equal(report.cardName, "Example Provider Agent");
    assert.deepEqual(report.providerParams, {
      tokenId: 10n,
      cardHash: createHash("sha256").update(exampleCard()).digest("hex"),
    });
  });

  test("a card changed by one byte fails the hash check", () => {
    // Change one letter inside the description: still valid JSON with a name.
    const text = Buffer.from(exampleCard()).toString("utf8");
    assert.ok(text.includes("A sample Agent Card"));
    const card = new Uint8Array(Buffer.from(text.replace("A sample", "A simple"), "utf8"));
    const report = checkBadge({
      tokenId: 10n,
      view: decodeAgentView(agentReply(VERIFIED)),
      cardBytes: card,
    });
    assert.deepEqual(codes(report), ["card-hash-mismatch"]);
    assert.equal(report.eligible, false);
    assert.equal(report.providerParams, null);
  });

  test("a revoked agent is not verified", () => {
    const report = checkBadge({
      tokenId: 11n,
      view: decodeAgentView(agentReply(REVOKED)),
      cardBytes: exampleCard(),
    });
    assert.deepEqual(codes(report), ["not-active"]);
    assert.equal(report.verified, false);
  });

  test("an agent without a wallet is verified but not eligible", () => {
    const report = checkBadge({
      tokenId: 12n,
      view: decodeAgentView(agentReply(NO_WALLET)),
      cardBytes: exampleCard(),
    });
    assert.equal(report.verified, true);
    assert.equal(report.eligible, false);
    assert.deepEqual(codes(report), ["no-agent-wallet"]);
  });

  test("a card that is not JSON, or has no name, is malformed", () => {
    const view = decodeAgentView(agentReply(VERIFIED));
    for (const text of ["not json", "[]", '{"description":"no name"}', '{"name":"  "}']) {
      const bytes = new Uint8Array(Buffer.from(text));
      const withHash = { ...view, metadataHash: new Uint8Array(createHash("sha256").update(bytes).digest()) };
      const report = checkBadge({ tokenId: 10n, view: withHash, cardBytes: bytes });
      assert.deepEqual(codes(report), ["card-malformed"], text);
    }
  });

  test("a reply for another token, or without uri, hash or card, is reported", () => {
    const view = decodeAgentView(agentReply(VERIFIED));
    assert.deepEqual(
      codes(checkBadge({ tokenId: 99n, view, cardBytes: exampleCard() })),
      ["token-mismatch"],
    );
    assert.deepEqual(
      codes(checkBadge({ tokenId: 10n, view: { ...view, agentUri: null, metadataHash: null }, cardBytes: null })),
      ["no-agent-uri", "no-card-hash"],
    );
    const unavailable = checkBadge({ tokenId: 10n, view, cardBytes: null, cardError: "timeout" });
    assert.deepEqual(codes(unavailable), ["card-unavailable"]);
    assert.equal(unavailable.issues[0]?.message, "timeout");
  });
});
