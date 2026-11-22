/**
 * The `vault-exact` x402 scheme: an exact CCD payment made through a
 * GuardVault, so the vault's caps, allowlist and receipts apply to every paid
 * request. See `docs/x402-vault-scheme.md`.
 */

import { createHash, randomBytes } from "node:crypto";

import { AccountAddress } from "@concordium/web-sdk";
import { ByteReader, DecodeError, fromHex, toHex } from "@claw-pay-concordium/verifier";
import type { Network, PaymentRequirements } from "@x402/core/types";

export const SCHEME = "vault-exact";
/** Concordium testnet, as CAIP-2 (from the x402 `exact` Concordium spec). */
export const CONCORDIUM_TESTNET: Network = "ccd:4221332d34e1694168c2a0c0b3fd0f27";
export const ASSET = "CCD";
export const PAY_ENTRYPOINT = "guard_vault.pay";
/** Upper bound on how long a payment transaction may stay valid. */
export const MAX_TIMEOUT_SECONDS = 60;
export const INVOICE_DOMAIN = "claw-pay-concordium/x402-vault-exact/v1";

/** GuardVault's `pay` parameter. Amounts are micro-CCD. */
export interface PayParams {
  provider: bigint;
  amount: bigint;
  nonce: bigint;
  invoiceHash: Uint8Array;
}

export const PAY_PARAMS_LENGTH = 8 + 8 + 8 + 32;
const U64_MAX = (1n << 64n) - 1n;

function u64(value: bigint): Uint8Array {
  if (value < 0n || value > U64_MAX) {
    throw new RangeError(`${String(value)} does not fit in a u64`);
  }
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** Serialize `PayParams` exactly as the contract does. */
export function encodePayParams(params: PayParams): Uint8Array {
  if (params.invoiceHash.length !== 32) {
    throw new RangeError("invoice hash must be 32 bytes");
  }
  return new Uint8Array(
    Buffer.concat([u64(params.provider), u64(params.amount), u64(params.nonce), params.invoiceHash]),
  );
}

/** Decode `PayParams`. Throws `DecodeError` unless exactly 56 bytes. */
export function decodePayParams(bytes: Uint8Array): PayParams {
  const reader = new ByteReader(bytes);
  const params: PayParams = {
    provider: reader.u64(),
    amount: reader.u64(),
    nonce: reader.u64(),
    invoiceHash: reader.bytes(32),
  };
  reader.finish();
  return params;
}

/** Thrown when payment requirements are not a valid `vault-exact` offer. */
export class RequirementsError extends Error {
  override name = "RequirementsError";
}

/** Validated `vault-exact` requirements. */
export interface VaultExactRequirements {
  network: Network;
  amount: bigint;
  /** The seller's registry `agent_wallet` (Base58). */
  payTo: string;
  maxTimeoutSeconds: number;
  /** The sponsor account that pays transaction fees (Base58). */
  feePayer: string;
  /** The seller's registry token id. */
  provider: bigint;
  /** Fresh per 402 answer; 16 bytes. */
  invoiceId: Uint8Array;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function decimal(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value)) {
    throw new RequirementsError(`${what} must be a decimal string`);
  }
  const parsed = BigInt(value);
  if (parsed > U64_MAX) {
    throw new RequirementsError(`${what} does not fit in a u64`);
  }
  return parsed;
}

function account(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new RequirementsError(`${what} must be a Base58 account address`);
  }
  try {
    AccountAddress.fromBase58(value);
  } catch {
    throw new RequirementsError(`${what} is not a valid account address`);
  }
  return value;
}

/** Check that `requirements` is a well-formed `vault-exact` offer. */
export function parseRequirements(requirements: PaymentRequirements): VaultExactRequirements {
  if (requirements.scheme !== SCHEME) {
    throw new RequirementsError(`scheme must be "${SCHEME}"`);
  }
  if (!requirements.network.startsWith("ccd:")) {
    throw new RequirementsError("network must be a Concordium (ccd:) network");
  }
  if (requirements.asset !== ASSET) {
    throw new RequirementsError(`asset must be "${ASSET}"`);
  }
  const amount = decimal(requirements.amount, "amount");
  if (amount === 0n) {
    throw new RequirementsError("amount must be greater than zero");
  }
  const timeout = requirements.maxTimeoutSeconds;
  if (!Number.isInteger(timeout) || timeout < 1 || timeout > MAX_TIMEOUT_SECONDS) {
    throw new RequirementsError(`maxTimeoutSeconds must be 1 to ${String(MAX_TIMEOUT_SECONDS)}`);
  }
  const extra = requirements.extra;
  const invoiceId = extra["invoiceId"];
  if (typeof invoiceId !== "string" || !/^[0-9a-f]{32}$/.test(invoiceId)) {
    throw new RequirementsError("extra.invoiceId must be 32 lowercase hex digits");
  }
  return {
    network: requirements.network,
    amount,
    payTo: account(requirements.payTo, "payTo"),
    maxTimeoutSeconds: timeout,
    feePayer: account(extra["feePayer"], "extra.feePayer"),
    provider: decimal(extra["provider"], "extra.provider"),
    invoiceId: fromHex(invoiceId),
  };
}

function field(text: string): Buffer {
  const bytes = Buffer.from(text, "utf8");
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/**
 * The invoice hash the agent puts in `pay`: SHA-256 over the domain tag and
 * the offer's fields, each length-prefixed so field boundaries can't shift.
 * The vault refuses to pay the same invoice hash twice.
 */
export function invoiceHash(requirements: VaultExactRequirements): Uint8Array {
  const parts = [
    INVOICE_DOMAIN,
    requirements.network,
    String(requirements.amount),
    ASSET,
    requirements.payTo,
    String(requirements.provider),
    toHex(requirements.invoiceId),
  ];
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(field(part));
  }
  return new Uint8Array(hash.digest());
}

export interface OfferInput {
  network: Network;
  amount: bigint;
  payTo: string;
  feePayer: string;
  provider: bigint;
  maxTimeoutSeconds?: number;
}

/** Seller side: build `vault-exact` requirements with a fresh invoice id. */
export function newRequirements(offer: OfferInput): PaymentRequirements {
  const requirements: PaymentRequirements = {
    scheme: SCHEME,
    network: offer.network,
    asset: ASSET,
    amount: String(offer.amount),
    payTo: offer.payTo,
    maxTimeoutSeconds: offer.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS,
    extra: {
      feePayer: offer.feePayer,
      provider: String(offer.provider),
      invoiceId: toHex(new Uint8Array(randomBytes(16))),
    },
  };
  parseRequirements(requirements);
  return requirements;
}

export { DecodeError };
