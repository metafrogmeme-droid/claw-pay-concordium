/**
 * Exporting a vault's finalized events for `claw-pay-verify`.
 *
 * Scans finalized blocks `fromHeight..toHeight` (by default up to the last
 * finalized height, never beyond it), collects the vault's raw events in
 * chain order, and reads `view` at the `toHeight` block so the events and the
 * head are one consistent snapshot. The result is a
 * `claw-pay-concordium/vault-events/v1` file.
 *
 * If `fromHeight` is after the vault's init block, the export is incomplete
 * and the verifier refuses it (the receipt chain no longer starts at zero).
 */

import { BlockHash, type ContractAddress } from "@concordium/web-sdk";
import { EVENTS_FILE_FORMAT, toHex } from "@claw-pay-concordium/verifier";

import type { NodeClient } from "./node-client.ts";
import { vaultEventsFromSummary } from "./trace.ts";
import { readVaultView } from "./vault-view.ts";

export type ExportClient = Pick<NodeClient, "getConsensusStatus" | "getBlocksAtHeight" | "getBlockTransactionEvents" | "invokeContract">;

export interface ExportOptions {
  client: ExportClient;
  vault: ContractAddress.Type;
  /** The first block to scan: the vault's init block or earlier. */
  fromHeight: bigint;
  /** The last block to scan. Defaults to, and may not exceed, the last finalized height. */
  toHeight?: bigint;
  /** Called after each block. */
  onBlock?: (height: bigint) => void;
}

export interface EventsFileJson {
  format: string;
  source: string;
  vault: { index: number; subindex: number };
  view: { next_nonce: number; receipt_head: string };
  events: string[];
}

export interface ExportResult {
  file: EventsFileJson;
  fromHeight: bigint;
  toHeight: bigint;
  /** The block the view was read at (hex). */
  blockHash: string;
}

/** Thrown when the requested range cannot be exported. */
export class ExportError extends Error {
  override name = "ExportError";
}

function safeNumber(value: bigint, what: string): number {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new ExportError(`${what} is too large for the events file`);
  }
  return Number(value);
}

export async function exportVaultEvents(options: ExportOptions): Promise<ExportResult> {
  const { client, vault, fromHeight } = options;
  const lastFinalized = (await client.getConsensusStatus()).lastFinalizedBlockHeight;
  const toHeight = options.toHeight ?? lastFinalized;
  if (toHeight > lastFinalized) {
    throw new ExportError(`toHeight ${String(toHeight)} is above the last finalized height ${String(lastFinalized)}`);
  }
  if (fromHeight < 0n || fromHeight > toHeight) {
    throw new ExportError(`fromHeight ${String(fromHeight)} must be from 0 to toHeight ${String(toHeight)}`);
  }

  const events: string[] = [];
  let lastHash: BlockHash.Type | undefined;
  for (let height = fromHeight; height <= toHeight; height += 1n) {
    const hashes = await client.getBlocksAtHeight(height);
    const [hash, ...extra] = hashes;
    if (hash === undefined || extra.length > 0) {
      throw new ExportError(`expected exactly one finalized block at height ${String(height)}`);
    }
    for await (const item of client.getBlockTransactionEvents(hash)) {
      for (const event of vaultEventsFromSummary(item, vault)) {
        events.push(toHex(event));
      }
    }
    lastHash = hash;
    options.onBlock?.(height);
  }
  if (lastHash === undefined) {
    throw new ExportError("no blocks scanned");
  }

  const view = await readVaultView(client, vault, lastHash);
  const blockHash = BlockHash.toHexString(lastHash);
  return {
    file: {
      format: EVENTS_FILE_FORMAT,
      source: `Concordium testnet node; finalized blocks ${String(fromHeight)}..${String(toHeight)}; view at block ${blockHash}`,
      vault: { index: safeNumber(vault.index, "vault index"), subindex: safeNumber(vault.subindex, "vault subindex") },
      view: { next_nonce: safeNumber(view.nextNonce, "next_nonce"), receipt_head: toHex(view.receiptHead) },
      events,
    },
    fromHeight,
    toHeight,
    blockHash,
  };
}
