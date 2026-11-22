import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { DecodeError, ByteReader, fromHex, toHex, u64Bytes } from "./bytes.ts";
import { decodeEvent, encodeReceiptBody, type ReceiptBody } from "./events.ts";

describe("ByteReader", () => {
  test("reads little-endian u32", () => {
    const reader = new ByteReader(new Uint8Array([0x04, 0x03, 0x02, 0x01]));
    assert.equal(reader.u32(), 0x01020304);
    reader.finish();
    assert.throws(() => new ByteReader(new Uint8Array(2)).u32(), DecodeError);
  });

  test("reads little-endian u64 and refuses short input", () => {
    const reader = new ByteReader(u64Bytes(0x0102030405060708n));
    assert.equal(reader.u64(), 0x0102030405060708n);
    reader.finish();
    assert.throws(() => new ByteReader(new Uint8Array(3)).u64(), DecodeError);
  });

  test("rejects trailing bytes and bad bools", () => {
    const reader = new ByteReader(new Uint8Array([1, 2]));
    reader.u8();
    assert.throws(() => {
      reader.finish();
    }, DecodeError);
    assert.throws(() => new ByteReader(new Uint8Array([2])).bool(), DecodeError);
  });

  test("hex round-trips and rejects odd or non-hex input", () => {
    assert.equal(toHex(fromHex("00ff10")), "00ff10");
    assert.throws(() => fromHex("abc"), DecodeError);
    assert.throws(() => fromHex("zz"), DecodeError);
  });
});

describe("decodeEvent", () => {
  test("decodes small owner events", () => {
    assert.deepEqual(decodeEvent(fromHex("0100e1f50500000000")), {
      kind: "Deposited",
      amount: 100_000_000n,
    });
    assert.deepEqual(decodeEvent(fromHex("0501")), { kind: "PausedSet", paused: true });
    assert.deepEqual(decodeEvent(fromHex("070200000000000000")), {
      kind: "ProviderRemoved",
      tokenId: 2n,
    });
  });

  test("rejects unknown tags, short events and trailing bytes", () => {
    assert.throws(() => decodeEvent(fromHex("2a")), /unknown event tag 42/);
    assert.throws(() => decodeEvent(fromHex("01e1f505")), DecodeError);
    assert.throws(() => decodeEvent(fromHex("050100")), /trailing/);
  });

  test("receipt body encodes to 208 bytes and decodes back", () => {
    const body: ReceiptBody = {
      vault: { index: 1n, subindex: 0n },
      nonce: 7n,
      prevHash: new Uint8Array(32).fill(0xaa),
      timestamp: 1_795_262_400_000n,
      agent: new Uint8Array(32).fill(2),
      provider: 9n,
      cardHash: new Uint8Array(32).fill(0xc1),
      payee: new Uint8Array(32).fill(3),
      amount: 1_500_000n,
      invoiceHash: new Uint8Array(32).fill(4),
    };
    const bodyBytes = encodeReceiptBody(body);
    assert.equal(bodyBytes.length, 208);
    const hash = new Uint8Array(32).fill(0xee);
    const event = decodeEvent(new Uint8Array([8, ...bodyBytes, ...hash]));
    assert.equal(event.kind, "Receipt");
    assert.deepEqual(event.body, body);
    assert.deepEqual(event.bodyBytes, bodyBytes);
    assert.deepEqual(event.hash, hash);
  });
});
