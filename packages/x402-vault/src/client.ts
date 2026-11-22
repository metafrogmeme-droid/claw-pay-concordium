/**
 * Agent side of `vault-exact`: turn x402 payment requirements into a
 * sponsored V1 `UpdateContract` that calls `guard_vault.pay`, signed by the
 * agent key. The facilitator adds the sponsor signature and submits it.
 */

import {
  AccountAddress,
  CcdAmount,
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  TransactionExpiry,
  type AccountSigner,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import type {
  PaymentPayloadResult,
  PaymentRequirements,
  SchemeNetworkClient,
} from "@x402/core/types";

import {
  PAY_ENTRYPOINT,
  SCHEME,
  encodePayParams,
  invoiceHash,
  parseRequirements,
} from "./scheme.ts";

export interface AgentContext {
  /** The agent's GuardVault instance. */
  vault: ContractAddress.Type;
  /** The vault's agent account (the transaction sender). */
  agent: AccountAddress.Type;
  /** Signs with the agent key. Never stored by this package. */
  signer: AccountSigner;
  /** Maximum execution energy for the `pay` call. */
  energy: bigint;
  /** The vault's next nonce (from its `view`). */
  vaultNonce(): Promise<bigint>;
  /** The agent account's next sequence number. */
  accountSequence(): Promise<bigint>;
  /** Current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** Build and sign the `vault-exact` payload for `requirements`. */
export async function createVaultPayment(
  requirements: PaymentRequirements,
  agent: AgentContext,
): Promise<Record<string, unknown>> {
  const offer = parseRequirements(requirements);
  const message = encodePayParams({
    provider: offer.provider,
    amount: offer.amount,
    nonce: await agent.vaultNonce(),
    invoiceHash: invoiceHash(offer),
  });
  const parameter = new Uint8Array(message.length);
  parameter.set(message);
  const nowSeconds = Math.floor((agent.now ?? Date.now)() / 1000);
  const signable = Transaction.updateContract(
    {
      amount: CcdAmount.zero(),
      address: agent.vault,
      receiveName: ReceiveName.fromString(PAY_ENTRYPOINT),
      message: Parameter.fromBuffer(parameter.buffer),
    },
    Energy.create(agent.energy),
  )
    .addMetadata({
      sender: agent.agent,
      nonce: SequenceNumber.create(await agent.accountSequence()),
      expiry: TransactionExpiry.fromEpochSeconds(nowSeconds + offer.maxTimeoutSeconds),
    })
    .addSponsor(AccountAddress.fromBase58(offer.feePayer))
    .build();
  const signed = await Transaction.sign(signable, agent.signer);
  return { signedTransaction: toJsonSafe(Transaction.toJSON(signed)) };
}

/**
 * Make SDK JSON safe for `JSON.stringify`: bigints become numbers when they
 * fit, else decimal strings. `Transaction.signableFromJSON` accepts both.
 */
export function toJsonSafe(value: unknown): unknown {
  if (typeof value === "bigint") {
    return value <= BigInt(Number.MAX_SAFE_INTEGER) && value >= BigInt(Number.MIN_SAFE_INTEGER)
      ? Number(value)
      : value.toString();
  }
  if (Array.isArray(value)) {
    return value.map(toJsonSafe);
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, inner]) => [key, toJsonSafe(inner)]));
  }
  return value;
}

/** `vault-exact` as an `@x402/core` client scheme. */
export class VaultExactClient implements SchemeNetworkClient {
  readonly scheme = SCHEME;
  readonly #agent: AgentContext;

  constructor(agent: AgentContext) {
    this.#agent = agent;
  }

  async createPaymentPayload(
    x402Version: number,
    paymentRequirements: PaymentRequirements,
  ): Promise<PaymentPayloadResult> {
    return { x402Version, payload: await createVaultPayment(paymentRequirements, this.#agent) };
  }
}
