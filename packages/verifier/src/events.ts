/**
 * Decoding of GuardVault events, mirroring the event table in
 * `contracts/guard-vault/README.md`. Each event starts with a one-byte tag
 * (the variant index), followed by its fields in Concordium serialization.
 */

import { ByteReader, DecodeError, concatBytes, u64Bytes } from "./bytes.ts";

/** Byte length of a serialized receipt body. */
export const RECEIPT_BODY_LENGTH = 208;
/** Byte length of a SHA-256 hash. */
export const HASH_LENGTH = 32;

export interface ContractAddress {
  index: bigint;
  subindex: bigint;
}

/** The hashed part of a receipt. Amounts are micro-CCD; times are ms. */
export interface ReceiptBody {
  vault: ContractAddress;
  nonce: bigint;
  prevHash: Uint8Array;
  timestamp: bigint;
  agent: Uint8Array;
  provider: bigint;
  cardHash: Uint8Array;
  payee: Uint8Array;
  amount: bigint;
  invoiceHash: Uint8Array;
}

export type VaultEvent =
  | {
      kind: "Initialized";
      owner: Uint8Array;
      agent: Uint8Array;
      perTxCap: bigint;
      dailyCap: bigint;
      registry: ContractAddress;
    }
  | { kind: "Deposited"; amount: bigint }
  | { kind: "Withdrawn"; amount: bigint }
  | { kind: "CapsSet"; perTxCap: bigint; dailyCap: bigint }
  | { kind: "AgentSet"; agent: Uint8Array }
  | { kind: "PausedSet"; paused: boolean }
  | { kind: "ProviderAdded"; tokenId: bigint; cardHash: Uint8Array; wallet: Uint8Array }
  | { kind: "ProviderRemoved"; tokenId: bigint }
  | {
      kind: "Receipt";
      body: ReceiptBody;
      /** The body exactly as logged: the bytes the contract hashed. */
      bodyBytes: Uint8Array;
      hash: Uint8Array;
    };

function account(reader: ByteReader): Uint8Array {
  return reader.bytes(32);
}

function contractAddress(reader: ByteReader): ContractAddress {
  return { index: reader.u64(), subindex: reader.u64() };
}

function decodeReceiptBody(bytes: Uint8Array): ReceiptBody {
  const reader = new ByteReader(bytes);
  const body: ReceiptBody = {
    vault: contractAddress(reader),
    nonce: reader.u64(),
    prevHash: reader.bytes(HASH_LENGTH),
    timestamp: reader.u64(),
    agent: account(reader),
    provider: reader.u64(),
    cardHash: reader.bytes(HASH_LENGTH),
    payee: account(reader),
    amount: reader.u64(),
    invoiceHash: reader.bytes(HASH_LENGTH),
  };
  reader.finish();
  return body;
}

/** Decode one vault event. Throws `DecodeError` on any layout mismatch. */
export function decodeEvent(bytes: Uint8Array): VaultEvent {
  const reader = new ByteReader(bytes);
  const tag = reader.u8();
  let event: VaultEvent;
  switch (tag) {
    case 0:
      event = {
        kind: "Initialized",
        owner: account(reader),
        agent: account(reader),
        perTxCap: reader.u64(),
        dailyCap: reader.u64(),
        registry: contractAddress(reader),
      };
      break;
    case 1:
      event = { kind: "Deposited", amount: reader.u64() };
      break;
    case 2:
      event = { kind: "Withdrawn", amount: reader.u64() };
      break;
    case 3:
      event = { kind: "CapsSet", perTxCap: reader.u64(), dailyCap: reader.u64() };
      break;
    case 4:
      event = { kind: "AgentSet", agent: account(reader) };
      break;
    case 5:
      event = { kind: "PausedSet", paused: reader.bool() };
      break;
    case 6:
      event = {
        kind: "ProviderAdded",
        tokenId: reader.u64(),
        cardHash: reader.bytes(HASH_LENGTH),
        wallet: account(reader),
      };
      break;
    case 7:
      event = { kind: "ProviderRemoved", tokenId: reader.u64() };
      break;
    case 8: {
      const bodyBytes = reader.bytes(RECEIPT_BODY_LENGTH);
      const hash = reader.bytes(HASH_LENGTH);
      event = { kind: "Receipt", body: decodeReceiptBody(bodyBytes), bodyBytes, hash };
      break;
    }
    default:
      throw new DecodeError(`unknown event tag ${String(tag)}`);
  }
  reader.finish();
  return event;
}

/** Serialize a receipt body the way the contract does (for tests and tools). */
export function encodeReceiptBody(body: ReceiptBody): Uint8Array {
  return concatBytes([
    u64Bytes(body.vault.index),
    u64Bytes(body.vault.subindex),
    u64Bytes(body.nonce),
    body.prevHash,
    u64Bytes(body.timestamp),
    body.agent,
    u64Bytes(body.provider),
    body.cardHash,
    body.payee,
    u64Bytes(body.amount),
    body.invoiceHash,
  ]);
}

/** A full `Receipt` event: tag 8, body, hash. */
export function encodeReceiptEvent(bodyBytes: Uint8Array, hash: Uint8Array): Uint8Array {
  return concatBytes([new Uint8Array([8]), bodyBytes, hash]);
}
