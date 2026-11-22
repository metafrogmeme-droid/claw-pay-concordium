/**
 * Test-only helpers for this package. Keys are generated in memory for one
 * test run and dropped: never written to disk, logged, funded or used on any
 * network.
 */

import { generateKeyPairSync } from "node:crypto";

import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  TransactionExpiry,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { encodePayParams, type SignerAccount } from "@claw-pay-concordium/x402-vault";

function hex(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("key export is missing a field");
  }
  return Buffer.from(value, "base64url").toString("hex");
}

/**
 * A testnet-style wallet export JSON string for a fresh in-memory key, at an
 * address filled with `byte`, plus the account record to verify its signatures.
 */
export function walletExport(byte: number, environment = "testnet"): { json: string; address: AccountAddress.Type; account: SignerAccount } {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signKey = hex(privateKey.export({ format: "jwk" }).d);
  const verifyKey = hex(publicKey.export({ format: "jwk" }).x);
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(byte).buffer);
  const json = JSON.stringify({
    type: "concordium-browser-wallet-account",
    v: 0,
    environment,
    value: {
      address: AccountAddress.toBase58(address),
      credentials: { 0: "00".repeat(48) },
      accountKeys: { threshold: 1, keys: { 0: { threshold: 1, keys: { 0: { signKey, verifyKey } } } } },
    },
  });
  const account = {
    accountAddress: address,
    accountThreshold: 1,
    accountCredentials: {
      0: { v: 0, value: { type: "normal", contents: { credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey } } } } } },
    },
  } as unknown as SignerAccount;
  return { json, address, account };
}

export interface PayOverrides {
  sender?: AccountAddress.Type;
  vault?: ContractAddress.Type;
  entrypoint?: string;
  attachedMicroCcd?: bigint;
  amount?: bigint;
  message?: Uint8Array;
  energy?: bigint;
  expiryOffsetSeconds?: number;
  sponsored?: boolean;
  /** Build a plain CCD transfer instead of a contract update. */
  transfer?: boolean;
}

/** An unsigned `guard_vault.pay` transaction, with fields overridden for negative tests. */
export function unsignedPay(
  defaults: { agent: AccountAddress.Type; vault: ContractAddress.Type; nowMs: number },
  overrides: PayOverrides = {},
): Transaction.Signable {
  const message =
    overrides.message ??
    encodePayParams({ provider: 10n, amount: overrides.amount ?? 1_000_000n, nonce: 0n, invoiceHash: new Uint8Array(32).fill(1) });
  const parameter = new Uint8Array(message.length);
  parameter.set(message);
  const metadata = {
    sender: overrides.sender ?? defaults.agent,
    nonce: SequenceNumber.create(1n),
    expiry: TransactionExpiry.fromEpochSeconds(Math.floor(defaults.nowMs / 1000) + (overrides.expiryOffsetSeconds ?? 60)),
  };
  const sponsor = AccountAddress.fromBuffer(new Uint8Array(32).fill(0x09).buffer);
  if (overrides.transfer === true) {
    return Transaction.transfer({ amount: CcdAmount.fromMicroCcd(1n), toAddress: sponsor }).addMetadata(metadata).addSponsor(sponsor).build();
  }
  const builder = Transaction.updateContract(
    {
      amount: CcdAmount.fromMicroCcd(overrides.attachedMicroCcd ?? 0n),
      address: overrides.vault ?? defaults.vault,
      receiveName: ReceiveName.fromString(overrides.entrypoint ?? "guard_vault.pay"),
      message: Parameter.fromBuffer(parameter.buffer),
    },
    Energy.create(overrides.energy ?? 30_000n),
  ).addMetadata(metadata);
  return overrides.sponsored === false ? builder.build() : builder.addSponsor(sponsor).build();
}
