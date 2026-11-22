/**
 * What the facilitator needs from the Concordium chain. Only interfaces here:
 * the live implementation on `ConcordiumGRPCNodeClient` arrives with PR 5 and
 * runs on the operator box. Tests use an in-memory fake.
 */

import type { AccountAddress, AccountInfo, ContractAddress } from "@concordium/web-sdk";
import type { Transaction } from "@concordium/web-sdk/transactions";

/** The parts of account info needed to verify a signature. */
export type SignerAccount = Pick<AccountInfo, "accountThreshold" | "accountCredentials" | "accountAddress">;

export type DryRunResult =
  | {
      ok: true;
      /** Raw events logged by the vault during the dry run, in order. */
      events: Uint8Array[];
    }
  | {
      ok: false;
      /** The contract's reject code, when it rejected. */
      rejectCode: number | null;
      message: string;
    };

export type FinalizationResult =
  | { status: "finalized"; success: true; events: Uint8Array[] }
  | { status: "finalized"; success: false; rejectCode: number | null; message: string }
  | { status: "timeout" };

export interface VaultChain {
  getAccountInfo(account: AccountAddress.Type): Promise<SignerAccount>;
  /** The vault's agent, from its `view` entrypoint. */
  getVaultAgent(vault: ContractAddress.Type): Promise<AccountAddress.Type>;
  /** Invoke `guard_vault.pay` as `invoker` without committing anything. */
  dryRunPay(
    vault: ContractAddress.Type,
    invoker: AccountAddress.Type,
    message: Uint8Array,
    energy: bigint,
  ): Promise<DryRunResult>;
  /** Submit a fully signed transaction; returns its hash in hex. */
  submit(transaction: Transaction.Finalized): Promise<string>;
  /** Wait until the transaction is finalized, or the timeout passes. */
  waitForFinalization(transactionHash: string, timeoutMs: number): Promise<FinalizationResult>;
}
