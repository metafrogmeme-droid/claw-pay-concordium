import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, test } from "node:test";

import { DecodeError, toHex } from "@claw-pay-concordium/verifier";

import { decodeAgentView } from "./agent-view.ts";
import { NO_WALLET, REVOKED, VERIFIED, agentReply, exampleCard } from "./test-fixtures.ts";

function u32(n: number): number[] {
  const b = Buffer.alloc(4);
  b.writeUInt32LE(n);
  return [...b];
}

function u64(n: bigint): number[] {
  const b = Buffer.alloc(8);
  b.writeBigUInt64LE(n);
  return [...b];
}

function str(s: string): number[] {
  const bytes = [...Buffer.from(s, "utf8")];
  return [...u32(bytes.length), ...bytes];
}

/** An AgentView written byte by byte from the CIS-8004 grammar. */
function specBytes(withExternalReference: boolean): Uint8Array {
  return new Uint8Array([
    8, ...u64(7n), // token_id
    ...new Array<number>(32).fill(0x11), // owner_account
    1, ...str("https://agent.example/card.json"), // agent_uri
    1, ...new Array<number>(32).fill(0xaa), // metadata_hash
    ...(withExternalReference
      ? [1, ...u64(42n), ...u64(0n), 0, ...str("eip155:1"), ...str("ed25519"), ...u32(32), ...new Array<number>(32).fill(2)]
      : [0]),
    1, ...new Array<number>(32).fill(0x33), // agent_wallet
    0, // status: Active
    ...u64(1_700_000_000_000n), // registered_at
    0, // revoked_at
    0, // revocation_reason
  ]);
}

describe("decodeAgentView", () => {
  test("decodes spec bytes with and without an external reference", () => {
    for (const withRef of [false, true]) {
      const view = decodeAgentView(specBytes(withRef));
      assert.equal(view.tokenId, 7n);
      assert.equal(view.agentUri, "https://agent.example/card.json");
      assert.deepEqual(view.metadataHash, new Uint8Array(32).fill(0xaa));
      assert.deepEqual(view.agentWallet, new Uint8Array(32).fill(0x33));
      assert.equal(view.status, "Active");
      assert.equal(view.registeredAt, 1_700_000_000_000n);
      assert.equal(view.revokedAt, null);
      if (withRef) {
        assert.equal(view.externalReference?.namespace, "eip155:1");
        assert.equal(view.externalReference.keyType, "ed25519");
        assert.equal(view.externalReference.contract.index, 42n);
      } else {
        assert.equal(view.externalReference, null);
      }
    }
  });

  test("decodes the registry replies produced by the contract tests", () => {
    const verified = decodeAgentView(agentReply(VERIFIED));
    assert.equal(verified.tokenId, 10n);
    assert.equal(verified.status, "Active");
    assert.equal(verified.agentUri, "https://provider.example/agent-card.json");
    const cardHash = createHash("sha256").update(exampleCard()).digest("hex");
    assert.equal(toHex(verified.metadataHash ?? new Uint8Array()), cardHash);
    assert.notEqual(verified.externalReference, null);
    assert.notEqual(verified.agentWallet, null);

    const revoked = decodeAgentView(agentReply(REVOKED));
    assert.equal(revoked.status, "Revoked");
    assert.notEqual(revoked.revokedAt, null);
    assert.equal(revoked.revocationReason, "revoked in test");

    const noWallet = decodeAgentView(agentReply(NO_WALLET));
    assert.equal(noWallet.status, "Active");
    assert.equal(noWallet.agentWallet, null);
  });

  test("rejects malformed replies", () => {
    const good = specBytes(false);
    const bad: Uint8Array[] = [
      good.slice(0, good.length - 1), // truncated
      new Uint8Array([...good, 0]), // trailing byte
      new Uint8Array([4, ...good.slice(1)]), // token id length not 8
      (() => {
        const b = good.slice();
        b[1 + 8 + 32] = 2; // agent_uri option tag
        return b;
      })(),
      (() => {
        const b = good.slice();
        b[b.length - 11] = 7; // status
        return b;
      })(),
      new Uint8Array([8, ...u64(1n), ...new Array<number>(32).fill(0), 1, ...u32(2), 0xc3, 0x28]), // invalid UTF-8
    ];
    for (const bytes of bad) {
      assert.throws(() => decodeAgentView(bytes), DecodeError);
    }
  });
});
