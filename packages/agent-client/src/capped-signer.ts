/**
 * capped-signer: the only thing that holds the agent key.
 *
 * It signs a transaction only if it is exactly what the agent may send: a
 * sponsored V1 `guard_vault.pay` from the agent, on the agent's own vault,
 * with no CCD attached, a well-formed `PayParams` within the per-payment cap,
 * capped energy and an expiry at most 60 s ahead. Anything else is refused
 * before the key is touched, even if every layer above it was bypassed.
 */

import {
  AccountAddress,
  AccountTransactionType,
  ContractAddress,
  Parameter,
  type AccountSigner,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import {
  MAX_TIMEOUT_SECONDS,
  PAY_ENTRYPOINT,
  decodePayParams,
  type TransactionSigner,
} from "@claw-pay-concordium/x402-vault";

export type SignRefusal =
  | "not_sponsored_v1"
  | "wrong_sender"
  | "not_contract_update"
  | "wrong_vault"
  | "wrong_entrypoint"
  | "ccd_attached"
  | "malformed_params"
  | "over_per_payment"
  | "energy_too_high"
  | "expired"
  | "expiry_too_far";

/** Thrown when the capped signer refuses a transaction. Nothing was signed. */
export class SignRefused extends Error {
  override name = "SignRefused";
  readonly reasons: SignRefusal[];

  constructor(reasons: SignRefusal[]) {
    super(`capped signer refused: ${reasons.join(", ")}`);
    this.reasons = reasons;
  }
}

export interface CappedSignerConfig {
  /** The agent key. Only this closure keeps a reference to it. */
  signer: AccountSigner;
  agent: AccountAddress.Type;
  vault: ContractAddress.Type;
  perPaymentMax: bigint;
  maxEnergy: bigint;
  /** Current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
}

/** Every reason `transaction` may not be signed under `config`. */
export function refusals(transaction: Transaction.Signable, config: Omit<CappedSignerConfig, "signer">): SignRefusal[] {
  const reasons: SignRefusal[] = [];
  const header = transaction.header;
  const sponsoredV1 = transaction.version === 1 && transaction.header.sponsor !== undefined;
  if (!sponsoredV1) {
    reasons.push("not_sponsored_v1");
  }
  if (!AccountAddress.equals(header.sender, config.agent)) {
    reasons.push("wrong_sender");
  }
  const payload = transaction.payload;
  if (payload.type !== AccountTransactionType.Update) {
    reasons.push("not_contract_update");
  } else {
    if (!ContractAddress.equals(payload.address, config.vault)) {
      reasons.push("wrong_vault");
    }
    if (payload.receiveName.toString() !== PAY_ENTRYPOINT) {
      reasons.push("wrong_entrypoint");
    }
    if (payload.amount.microCcdAmount !== 0n) {
      reasons.push("ccd_attached");
    }
    try {
      const params = decodePayParams(Parameter.toBuffer(payload.message));
      if (params.amount > config.perPaymentMax) {
        reasons.push("over_per_payment");
      }
    } catch {
      reasons.push("malformed_params");
    }
  }
  if (header.executionEnergyAmount.value > config.maxEnergy) {
    reasons.push("energy_too_high");
  }
  const nowSeconds = BigInt(Math.floor((config.now ?? Date.now)() / 1000));
  const expiry = header.expiry.expiryEpochSeconds;
  if (expiry <= nowSeconds) {
    reasons.push("expired");
  } else if (expiry > nowSeconds + BigInt(MAX_TIMEOUT_SECONDS)) {
    reasons.push("expiry_too_far");
  }
  return reasons;
}

/** A `TransactionSigner` that signs only capped `pay` calls on the agent's vault. */
export function createCappedSigner(config: CappedSignerConfig): TransactionSigner {
  const { signer, ...limits } = config;
  return async (transaction) => {
    const reasons = refusals(transaction, limits);
    if (reasons.length > 0) {
      throw new SignRefused(reasons);
    }
    return Transaction.sign(transaction, signer);
  };
}
