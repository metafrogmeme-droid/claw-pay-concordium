/**
 * x402-vault's `VaultChain` on a Concordium node: what the `vault-exact`
 * facilitator needs to verify, dry-run, submit and confirm a payment.
 */

import {
  ContractAddress,
  Energy,
  Parameter,
  ReceiveName,
  RejectReasonTag,
  TransactionHash,
  TransactionKindString,
  TransactionSummaryType,
  isKnown,
  type RejectReason,
  type Upward,
} from "@concordium/web-sdk";
import { PAY_ENTRYPOINT, type FinalizationResult, type VaultChain } from "@claw-pay-concordium/x402-vault";

import type { NodeClient } from "./node-client.ts";
import { vaultEventsFromTrace } from "./trace.ts";
import { readVaultView } from "./vault-view.ts";

function rejectCode(reason: Upward<RejectReason>): number | null {
  return isKnown(reason) && reason.tag === RejectReasonTag.RejectedReceive ? reason.rejectReason : null;
}

function describe(reason: Upward<RejectReason>): string {
  return isKnown(reason) ? reason.tag : "unknown reject reason";
}

function parameterOf(message: Uint8Array): Parameter.Type {
  const copy = new Uint8Array(message.length);
  copy.set(message);
  return Parameter.fromBuffer(copy.buffer);
}

export function nodeVaultChain(client: NodeClient): VaultChain {
  /** The vault each submitted transaction calls, to pick its events later. */
  const submitted = new Map<string, ContractAddress.Type>();

  return {
    getAccountInfo: (account) => client.getAccountInfo(account),

    getVaultAgent: async (vault) => (await readVaultView(client, vault)).agent,

    dryRunPay: async (vault, invoker, message, energy) => {
      const result = await client.invokeContract({
        invoker,
        contract: vault,
        method: ReceiveName.fromString(PAY_ENTRYPOINT),
        parameter: parameterOf(message),
        energy: Energy.create(energy),
      });
      if (result.tag === "success") {
        return { ok: true, events: vaultEventsFromTrace(result.events, vault) };
      }
      return { ok: false, rejectCode: rejectCode(result.reason), message: describe(result.reason) };
    },

    submit: async (transaction) => {
      const payload = transaction.payload;
      if (!("address" in payload) || !("receiveName" in payload)) {
        throw new Error("only contract updates are submitted");
      }
      const hash = TransactionHash.toHexString(await client.sendTransaction(transaction));
      submitted.set(hash, payload.address);
      return hash;
    },

    waitForFinalization: async (transactionHash, timeoutMs): Promise<FinalizationResult> => {
      const vault = submitted.get(transactionHash);
      if (vault === undefined) {
        throw new Error("waitForFinalization is for transactions submitted through this chain");
      }
      let outcome;
      try {
        outcome = await client.waitForTransactionFinalization(TransactionHash.fromHexString(transactionHash), timeoutMs);
      } catch {
        // A timeout or a lost stream: the outcome is unknown.
        return { status: "timeout" };
      }
      const summary = outcome.summary;
      if (!isKnown(summary) || summary.type !== TransactionSummaryType.AccountTransaction) {
        return { status: "timeout" };
      }
      if (summary.transactionType === TransactionKindString.Update) {
        return { status: "finalized", success: true, events: vaultEventsFromTrace(summary.events, vault) };
      }
      if (summary.transactionType === TransactionKindString.Failed) {
        return {
          status: "finalized",
          success: false,
          rejectCode: rejectCode(summary.rejectReason),
          message: describe(summary.rejectReason),
        };
      }
      return { status: "finalized", success: false, rejectCode: null, message: "not a contract update" };
    },
  };
}
