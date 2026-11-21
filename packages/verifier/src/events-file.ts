/**
 * The vault events file (`claw-pay-concordium/vault-events/v1`): the raw
 * bytes of every vault event in chain order, the vault address, and the
 * contract's own report of its receipt chain head. See
 * `fixtures/vault-events.v1.json` for an example.
 */

import { fromHex } from "./bytes.ts";
import { HASH_LENGTH, type ContractAddress } from "./events.ts";

export const EVENTS_FILE_FORMAT = "claw-pay-concordium/vault-events/v1";

export interface EventsFile {
  vault: ContractAddress;
  view: {
    /** Number of receipts the contract reports (its next nonce). */
    nextNonce: bigint;
    /** Hash of the last receipt, as reported by the contract. */
    receiptHead: Uint8Array;
  };
  /** Raw event bytes, in chain order. */
  events: Uint8Array[];
}

/** Thrown when the file does not have the expected shape. */
export class EventsFileError extends Error {
  override name = "EventsFileError";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function field(obj: Record<string, unknown>, key: string, where: string): unknown {
  if (!(key in obj)) {
    throw new EventsFileError(`missing ${where}${key}`);
  }
  return obj[key];
}

function u64Field(obj: Record<string, unknown>, key: string, where: string): bigint {
  const value = field(obj, key, where);
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new EventsFileError(`${where}${key} must be a non-negative integer`);
  }
  return BigInt(value);
}

function hexField(value: unknown, what: string, length?: number): Uint8Array {
  if (typeof value !== "string") {
    throw new EventsFileError(`${what} must be a hex string`);
  }
  let bytes: Uint8Array;
  try {
    bytes = fromHex(value);
  } catch {
    throw new EventsFileError(`${what} is not valid hex`);
  }
  if (length !== undefined && bytes.length !== length) {
    throw new EventsFileError(`${what} must be ${String(length)} bytes`);
  }
  return bytes;
}

/** Validate parsed JSON and convert it to an `EventsFile`. */
export function parseEventsFile(json: unknown): EventsFile {
  if (!isRecord(json)) {
    throw new EventsFileError("events file must be a JSON object");
  }
  if (json["format"] !== EVENTS_FILE_FORMAT) {
    throw new EventsFileError(`format must be "${EVENTS_FILE_FORMAT}"`);
  }
  const vault = field(json, "vault", "");
  const view = field(json, "view", "");
  const events = field(json, "events", "");
  if (!isRecord(vault)) {
    throw new EventsFileError("vault must be an object");
  }
  if (!isRecord(view)) {
    throw new EventsFileError("view must be an object");
  }
  if (!Array.isArray(events)) {
    throw new EventsFileError("events must be an array");
  }
  return {
    vault: {
      index: u64Field(vault, "index", "vault."),
      subindex: u64Field(vault, "subindex", "vault."),
    },
    view: {
      nextNonce: u64Field(view, "next_nonce", "view."),
      receiptHead: hexField(field(view, "receipt_head", "view."), "view.receipt_head", HASH_LENGTH),
    },
    events: events.map((event, i) => hexField(event, `events[${String(i)}]`)),
  };
}
