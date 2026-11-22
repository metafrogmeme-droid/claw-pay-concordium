/**
 * Test helpers. Keys here are generated in memory for one test run and then
 * dropped: never written to disk, logged, funded or used on any network.
 */

import { createHash, generateKeyPairSync } from "node:crypto";

import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  TransactionExpiry,
  buildBasicAccountSigner,
  type AccountSigner,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { encodeReceiptBody, encodeReceiptEvent } from "@claw-pay-concordium/verifier";
import type { PaymentPayload, PaymentRequirements } from "@x402/core/types";

import type { DryRunResult, FinalizationResult, SignerAccount, VaultChain } from "./chain.ts";
import { toJsonSafe } from "./client.ts";
import { decodePayParams, encodePayParams, invoiceHash, parseRequirements } from "./scheme.ts";

export interface TestAccount {
  address: AccountAddress.Type;
  signer: AccountSigner;
  account: SignerAccount;
}

function base64UrlToHex(value: string | undefined): string {
  if (value === undefined) {
    throw new Error("key export is missing a field");
  }
  return Buffer.from(value, "base64url").toString("hex");
}

/** A fresh ed25519 account, in memory only, at an address filled with `byte`. */
export function ephemeralAccount(byte: number): TestAccount {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const signer = buildBasicAccountSigner(base64UrlToHex(privateKey.export({ format: "jwk" }).d));
  const verifyKey = base64UrlToHex(publicKey.export({ format: "jwk" }).x);
  const address = AccountAddress.fromBuffer(new Uint8Array(32).fill(byte).buffer);
  // Only the fields Transaction.verifySignature reads, in the SDK's shape.
  const account = {
    accountAddress: address,
    accountThreshold: 1,
    accountCredentials: {
      0: {
        v: 0,
        value: {
          type: "normal",
          contents: {
            credentialPublicKeys: { threshold: 1, keys: { 0: { schemeId: "Ed25519", verifyKey } } },
          },
        },
      },
    },
  } as unknown as SignerAccount;
  return { address, signer, account };
}

export function addressOf(byte: number): AccountAddress.Type {
  return AccountAddress.fromBuffer(new Uint8Array(32).fill(byte).buffer);
}

/** A vault `Receipt` event matching a `pay` parameter. */
export function receiptEventFor(
  vault: ContractAddress.Type,
  agent: AccountAddress.Type,
  message: Uint8Array,
  payee: AccountAddress.Type,
): Uint8Array {
  const params = decodePayParams(message);
  const bodyBytes = encodeReceiptBody({
    vault: { index: vault.index, subindex: vault.subindex },
    nonce: params.nonce,
    prevHash: new Uint8Array(32),
    timestamp: 1_795_350_000_000n,
    agent: agent.decodedAddress,
    provider: params.provider,
    cardHash: new Uint8Array(32).fill(0xc1),
    payee: payee.decodedAddress,
    amount: params.amount,
    invoiceHash: params.invoiceHash,
  });
  const hash = new Uint8Array(createHash("sha256").update(bodyBytes).digest());
  return encodeReceiptEvent(bodyBytes, hash);
}

/** An in-memory chain with one vault. */
export class FakeChain implements VaultChain {
  readonly accounts = new Map<string, SignerAccount>();
  readonly submitted: Transaction.Finalized[] = [];
  agent: AccountAddress.Type;
  payee: AccountAddress.Type;
  dryRun: ((message: Uint8Array) => DryRunResult) | null = null;
  finalization: (() => Promise<FinalizationResult>) | null = null;
  #vault: ContractAddress.Type;

  constructor(vault: ContractAddress.Type, agent: AccountAddress.Type, payee: AccountAddress.Type) {
    this.#vault = vault;
    this.agent = agent;
    this.payee = payee;
  }

  addAccount(account: TestAccount): void {
    this.accounts.set(AccountAddress.toBase58(account.address), account.account);
  }

  getAccountInfo(account: AccountAddress.Type): Promise<SignerAccount> {
    const info = this.accounts.get(AccountAddress.toBase58(account));
    return info === undefined ? Promise.reject(new Error("unknown account")) : Promise.resolve(info);
  }

  getVaultAgent(): Promise<AccountAddress.Type> {
    return Promise.resolve(this.agent);
  }

  /** The default dry run: the vault accepts and logs the matching receipt. */
  dryRunPay(
    _vault: ContractAddress.Type,
    invoker: AccountAddress.Type,
    message: Uint8Array,
  ): Promise<DryRunResult> {
    if (this.dryRun !== null) {
      return Promise.resolve(this.dryRun(message));
    }
    return Promise.resolve({ ok: true, events: [receiptEventFor(this.#vault, invoker, message, this.payee)] });
  }

  submit(transaction: Transaction.Finalized): Promise<string> {
    this.submitted.push(transaction);
    return Promise.resolve("ab".repeat(32));
  }

  waitForFinalization(): Promise<FinalizationResult> {
    if (this.finalization !== null) {
      return this.finalization();
    }
    const last = this.submitted.at(-1);
    if (last === undefined) {
      return Promise.reject(new Error("nothing submitted"));
    }
    const payload = last.payload;
    if (!("message" in payload) || !("address" in payload)) {
      return Promise.reject(new Error("not a contract update"));
    }
    const message = Parameter.toBuffer(payload.message);
    return Promise.resolve({
      status: "finalized",
      success: true,
      events: [receiptEventFor(payload.address, last.header.sender, message, this.payee)],
    });
  }
}

export interface TxOverrides {
  signer?: AccountSigner;
  sender?: AccountAddress.Type;
  vault?: ContractAddress.Type;
  entrypoint?: string;
  attachedMicroCcd?: bigint;
  message?: Uint8Array;
  provider?: bigint;
  amount?: bigint;
  invoiceHash?: Uint8Array;
  sponsor?: AccountAddress.Type;
  expiryOffsetSeconds?: number;
  energy?: bigint;
}

/**
 * Build a signed `pay` transaction for `requirements`, like the client does,
 * with fields overridden for negative tests. The payload goes through
 * JSON.stringify/parse to model the HTTP hop.
 */
export async function paymentFor(
  requirements: PaymentRequirements,
  defaults: { vault: ContractAddress.Type; agent: TestAccount; nowMs: number },
  overrides: TxOverrides = {},
): Promise<PaymentPayload> {
  const offer = parseRequirements(requirements);
  const message =
    overrides.message ??
    encodePayParams({
      provider: overrides.provider ?? offer.provider,
      amount: overrides.amount ?? offer.amount,
      nonce: 0n,
      invoiceHash: overrides.invoiceHash ?? invoiceHash(offer),
    });
  const parameter = new Uint8Array(message.length);
  parameter.set(message);
  const nowSeconds = Math.floor(defaults.nowMs / 1000);
  const signable = Transaction.updateContract(
    {
      amount: CcdAmount.fromMicroCcd(overrides.attachedMicroCcd ?? 0n),
      address: overrides.vault ?? defaults.vault,
      receiveName: ReceiveName.fromString(overrides.entrypoint ?? "guard_vault.pay"),
      message: Parameter.fromBuffer(parameter.buffer),
    },
    Energy.create(overrides.energy ?? 30_000n),
  )
    .addMetadata({
      sender: overrides.sender ?? defaults.agent.address,
      nonce: SequenceNumber.create(1n),
      expiry: TransactionExpiry.fromEpochSeconds(nowSeconds + (overrides.expiryOffsetSeconds ?? 60)),
    })
    .addSponsor(overrides.sponsor ?? AccountAddress.fromBase58(offer.feePayer))
    .build();
  const signed = await Transaction.sign(signable, overrides.signer ?? defaults.agent.signer);
  const payload = { signedTransaction: toJsonSafe(Transaction.toJSON(signed)) };
  return {
    x402Version: 2,
    accepted: requirements,
    payload: JSON.parse(JSON.stringify(payload)) as Record<string, unknown>,
  };
}
