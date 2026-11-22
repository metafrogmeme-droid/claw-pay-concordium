/**
 * The vault's `view` entrypoint: decoding its return value and reading it
 * from a node. Layout (little-endian), 161 bytes:
 * owner (32) · agent (32) · registry (index u64, subindex u64) · per_tx_cap
 * (u64) · daily_cap (u64) · paused (bool) · next_nonce (u64) · current_day
 * (u64) · spent_today (u64) · balance (u64) · receipt_head (32).
 */

import {
  AccountAddress,
  ContractAddress,
  Energy,
  ReceiveName,
  ReturnValue,
  type BlockHash,
} from "@concordium/web-sdk";
import { ByteReader } from "@claw-pay-concordium/verifier";

import type { NodeClient } from "./testnet-guard.ts";

export const VAULT_VIEW_LENGTH = 161;
export const VIEW_ENTRYPOINT = "guard_vault.view";
const VIEW_ENERGY = 30_000n;

export interface VaultView {
  owner: AccountAddress.Type;
  agent: AccountAddress.Type;
  registry: ContractAddress.Type;
  perTxCap: bigint;
  dailyCap: bigint;
  paused: boolean;
  /** The next nonce, which is also the number of receipts so far. */
  nextNonce: bigint;
  /** UTC day (epoch ms ÷ 86 400 000) of the block the view was read at. */
  currentDay: bigint;
  /** Micro-CCD counted against `currentDay`'s cap. */
  spentToday: bigint;
  balance: bigint;
  /** Hash of the last receipt; all zeros before the first payment. */
  receiptHead: Uint8Array;
}

function account(bytes: Uint8Array): AccountAddress.Type {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return AccountAddress.fromBuffer(copy.buffer);
}

/** Decode `view`'s return value. Throws `DecodeError` unless exactly 161 bytes. */
export function decodeVaultView(bytes: Uint8Array): VaultView {
  const reader = new ByteReader(bytes);
  const view: VaultView = {
    owner: account(reader.bytes(32)),
    agent: account(reader.bytes(32)),
    registry: ContractAddress.create(reader.u64(), reader.u64()),
    perTxCap: reader.u64(),
    dailyCap: reader.u64(),
    paused: reader.bool(),
    nextNonce: reader.u64(),
    currentDay: reader.u64(),
    spentToday: reader.u64(),
    balance: reader.u64(),
    receiptHead: reader.bytes(32),
  };
  reader.finish();
  return view;
}

/** Thrown when the node cannot run `view`. */
export class ViewError extends Error {
  override name = "ViewError";
}

/** Read the vault's view, at `blockHash` or the last finalized block. */
export async function readVaultView(client: Pick<NodeClient, "invokeContract">, vault: ContractAddress.Type, blockHash?: BlockHash.Type): Promise<VaultView> {
  const result = await client.invokeContract(
    { contract: vault, method: ReceiveName.fromString(VIEW_ENTRYPOINT), energy: Energy.create(VIEW_ENERGY) },
    blockHash,
  );
  if (result.tag !== "success") {
    throw new ViewError(`view failed on ${vault.toString()}`);
  }
  if (result.returnValue === undefined) {
    throw new ViewError("view returned no value");
  }
  return decodeVaultView(ReturnValue.toBuffer(result.returnValue));
}
