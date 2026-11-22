/**
 * What the verifier page does, without the DOM, so it is tested in Node:
 * check an events file offline, or read a vault's finalized events live from
 * a Concordium testnet node (testnet genesis guard first) and check them.
 */

import { ContractAddress } from "@concordium/web-sdk";
import {
  assertTestnetNode,
  exportVaultEvents,
  type EventsFileJson,
  type ExportClient,
} from "@claw-pay-concordium/node-adapter/browser";
import { parseEventsFile, verify, type EventsFile, type Report } from "@claw-pay-concordium/verifier";

export interface Checked {
  file: EventsFile;
  report: Report;
}

/** Thrown for input the page cannot use; the message is shown to the reader. */
export class InputError extends Error {
  override name = "InputError";
}

/** Check an events file (its text) offline. */
export function checkFile(text: string): Checked {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    throw new InputError("This is not JSON. Expected a claw-pay-concordium/vault-events/v1 file.");
  }
  let file: EventsFile;
  try {
    file = parseEventsFile(json);
  } catch (error) {
    throw new InputError(`Not a vault events file: ${error instanceof Error ? error.message : String(error)}`);
  }
  return { file, report: verify(file) };
}

export interface LiveOptions {
  client: ExportClient;
  vault: ContractAddress.Type;
  fromHeight: bigint;
  toHeight?: bigint;
  onBlock?: (height: bigint) => void;
}

export interface LiveResult extends Checked {
  json: EventsFileJson;
  toHeight: bigint;
  blockHash: string;
}

/** Read the vault's finalized events from a testnet node and check them. */
export async function exportLive(options: LiveOptions): Promise<LiveResult> {
  await assertTestnetNode(options.client);
  const result = await exportVaultEvents({
    client: options.client,
    vault: options.vault,
    fromHeight: options.fromHeight,
    ...(options.toHeight === undefined ? {} : { toHeight: options.toHeight }),
    ...(options.onBlock === undefined ? {} : { onBlock: options.onBlock }),
  });
  const file = parseEventsFile(result.file);
  return { file, report: verify(file), json: result.file, toHeight: result.toHeight, blockHash: result.blockHash };
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/**
 * A gRPC-web node URL: https, or plain http on loopback only. Returns the
 * address and port for `ConcordiumGRPCWebClient`.
 */
export function parseNodeUrl(text: string): { address: string; port: number } {
  let url: URL;
  try {
    url = new URL(text.trim());
  } catch {
    throw new InputError("The node URL must look like https://node.example:20000");
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new InputError("The node URL must use https (plain http only for localhost)");
  }
  if (url.username !== "" || url.password !== "" || (url.pathname !== "/" && url.pathname !== "") || url.search !== "" || url.hash !== "") {
    throw new InputError("The node URL must be just a scheme, host and port");
  }
  const port = url.port === "" ? (url.protocol === "https:" ? 443 : 80) : Number(url.port);
  return { address: `${url.protocol}//${url.hostname}`, port };
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

/** `index` or `index,subindex`. */
export function parseVault(text: string): ContractAddress.Type {
  const [index = "", subindex = "0", ...rest] = text.trim().split(",").map((part) => part.trim());
  if (!DECIMAL.test(index) || !DECIMAL.test(subindex) || rest.length > 0) {
    throw new InputError("The vault must be <index> or <index>,<subindex>");
  }
  return ContractAddress.create(BigInt(index), BigInt(subindex));
}

/** A block height, or undefined when blank and `optional`. */
export function parseHeight(text: string, what: string, optional = false): bigint | undefined {
  const value = text.trim();
  if (value === "" && optional) {
    return undefined;
  }
  if (!DECIMAL.test(value)) {
    throw new InputError(`${what} must be a block height (a whole number)`);
  }
  return BigInt(value);
}
