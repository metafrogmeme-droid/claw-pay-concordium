/**
 * Signing and submitting the owner's transactions (ordinary, not sponsored),
 * and reading the outcome: the module reference for a deploy, the new vault
 * for an init, or the reject code for a failure.
 */

import {
  CcdAmount,
  ContractAddress,
  ContractName,
  Energy,
  Parameter,
  ReceiveName,
  SequenceNumber,
  TransactionExpiry,
  TransactionHash,
  TransactionKindString,
  TransactionSummaryType,
  isKnown,
  type AccountAddress,
  type AccountSigner,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import type { NodeClient } from "@claw-pay-concordium/node-adapter";

import { CONTRACT_NAME, type Plan } from "./plan.ts";

export interface Owner {
  address: AccountAddress.Type;
  signer: AccountSigner;
}

export type SendablePlan = Extract<Plan, { kind: "deploy" | "init" | "update" }>;

export type SendClient = Pick<NodeClient, "getNextAccountNonce" | "sendTransaction" | "waitForTransactionFinalization">;

export type SendOutcome =
  | { ok: true; transaction: string; moduleRef?: string; contract?: ContractAddress.Type }
  | { ok: false; transaction: string; rejectCode: number | null; reason: string };

/** Transactions expire if not included within this many seconds. */
const EXPIRY_SECONDS = 300;

function parameterOf(bytes: Uint8Array): Parameter.Type {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return Parameter.fromBuffer(copy.buffer);
}

/** Build and sign `plan` as the owner. `energy` is required for init and update. */
export async function signPlan(
  owner: Owner,
  plan: SendablePlan,
  options: { nonce: bigint; energy: bigint; nowMs: number },
): Promise<Transaction.Signable> {
  const metadata = {
    sender: owner.address,
    nonce: SequenceNumber.create(options.nonce),
    expiry: TransactionExpiry.fromEpochSeconds(Math.floor(options.nowMs / 1000) + EXPIRY_SECONDS),
  };
  let signable: Transaction.Signable;
  switch (plan.kind) {
    case "deploy":
      signable = Transaction.deployModule({ source: plan.source }).addMetadata(metadata).build();
      break;
    case "init":
      signable = Transaction.initContract(
        {
          amount: CcdAmount.zero(),
          moduleRef: plan.moduleRef,
          initName: ContractName.fromString(CONTRACT_NAME),
          param: parameterOf(plan.parameter),
        },
        Energy.create(options.energy),
      )
        .addMetadata(metadata)
        .build();
      break;
    case "update":
      signable = Transaction.updateContract(
        {
          amount: CcdAmount.fromMicroCcd(plan.amount),
          address: plan.vault,
          receiveName: ReceiveName.fromString(`${CONTRACT_NAME}.${plan.entrypoint}`),
          message: parameterOf(plan.parameter),
        },
        Energy.create(options.energy),
      )
        .addMetadata(metadata)
        .build();
      break;
  }
  return Transaction.sign(signable, owner.signer);
}

/** Submit a signed transaction and wait for it to be finalized. */
export async function submit(client: SendClient, signed: Transaction.Signable, timeoutMs: number): Promise<SendOutcome> {
  const hash = await client.sendTransaction(Transaction.finalize(signed));
  const transaction = TransactionHash.toHexString(hash);
  let outcome;
  try {
    outcome = await client.waitForTransactionFinalization(hash, timeoutMs);
  } catch {
    return { ok: false, transaction, rejectCode: null, reason: "not finalized in time; look the transaction up on CCDExplorer (testnet)" };
  }
  const summary = outcome.summary;
  if (!isKnown(summary) || summary.type !== TransactionSummaryType.AccountTransaction) {
    return { ok: false, transaction, rejectCode: null, reason: "the outcome could not be decoded; look the transaction up on CCDExplorer (testnet)" };
  }
  switch (summary.transactionType) {
    case TransactionKindString.DeployModule:
      return { ok: true, transaction, moduleRef: summary.moduleDeployed.contents };
    case TransactionKindString.InitContract:
      return { ok: true, transaction, contract: summary.contractInitialized.address };
    case TransactionKindString.Update:
      return { ok: true, transaction };
    case TransactionKindString.Failed: {
      const reason = summary.rejectReason;
      if (!isKnown(reason)) {
        return { ok: false, transaction, rejectCode: null, reason: "rejected (unknown reason)" };
      }
      const code = "rejectReason" in reason && typeof reason.rejectReason === "number" ? reason.rejectReason : null;
      return { ok: false, transaction, rejectCode: code, reason: `rejected: ${reason.tag}` };
    }
    default:
      return { ok: false, transaction, rejectCode: null, reason: `unexpected transaction type ${summary.transactionType}` };
  }
}

/** The owner's next sequence number. */
export async function nextNonce(client: Pick<NodeClient, "getNextAccountNonce">, owner: AccountAddress.Type): Promise<bigint> {
  return (await client.getNextAccountNonce(owner)).nonce.value;
}
