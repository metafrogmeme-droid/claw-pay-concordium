/**
 * Parameters of the vault's owner entrypoints, serialized exactly as the
 * contract reads them (little-endian). Tested byte for byte against
 * `fixtures/owner-params.v1.json`, which the contract tests write.
 */

import type { AccountAddress, ContractAddress } from "@concordium/web-sdk";

const U64_MAX = (1n << 64n) - 1n;

export function u64(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`${String(value)} does not fit in a u64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/** `InitParams { agent, per_tx_cap, daily_cap, registry }`: 64 bytes. */
export function encodeInitParams(params: {
  agent: AccountAddress.Type;
  perTxCap: bigint;
  dailyCap: bigint;
  registry: ContractAddress.Type;
}): Uint8Array {
  return concat([
    params.agent.decodedAddress,
    u64(params.perTxCap),
    u64(params.dailyCap),
    u64(params.registry.index),
    u64(params.registry.subindex),
  ]);
}

/** `CapsParams { per_tx_cap, daily_cap }`: 16 bytes. */
export function encodeCapsParams(params: { perTxCap: bigint; dailyCap: bigint }): Uint8Array {
  return concat([u64(params.perTxCap), u64(params.dailyCap)]);
}

/** `set_agent`: an `AccountAddress`, 32 bytes. */
export function encodeAccount(account: AccountAddress.Type): Uint8Array {
  return new Uint8Array(account.decodedAddress);
}

/** `set_paused`: a `bool`, 1 byte. */
export function encodeBool(value: boolean): Uint8Array {
  return new Uint8Array([value ? 1 : 0]);
}

/** `ProviderParams { token_id, card_hash }`: 40 bytes. */
export function encodeProviderParams(params: { tokenId: bigint; cardHash: Uint8Array }): Uint8Array {
  if (params.cardHash.length !== 32) {
    throw new RangeError("card hash must be 32 bytes");
  }
  return concat([u64(params.tokenId), params.cardHash]);
}
