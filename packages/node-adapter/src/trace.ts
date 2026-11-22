/**
 * Collecting one vault's raw events from what the node reports.
 *
 * A contract's events appear in `ContractInitialized` (init), `Updated`, and
 * `Interrupted` (events logged before the contract called another one, as
 * `pay` does with the registry). They are collected in trace order. An entry
 * the SDK could not decode (`null`) is refused, never skipped, so a receipt
 * can't go missing silently.
 */

import {
  ContractAddress,
  ContractEvent,
  TransactionEventTag,
  TransactionKindString,
  TransactionSummaryType,
  isKnown,
  type BlockItemSummary,
  type ContractTraceEvent,
  type Upward,
} from "@concordium/web-sdk";
import { fromHex } from "@claw-pay-concordium/verifier";

/** Thrown when the node reports something this SDK version cannot decode. */
export class UnknownEntryError extends Error {
  override name = "UnknownEntryError";
}

/** The vault's raw events in a contract update's trace, in order. */
export function vaultEventsFromTrace(trace: readonly Upward<ContractTraceEvent>[], vault: ContractAddress.Type): Uint8Array[] {
  const events: Uint8Array[] = [];
  for (const entry of trace) {
    if (!isKnown(entry)) {
      throw new UnknownEntryError("a contract trace entry could not be decoded; update the SDK");
    }
    if (
      (entry.tag === TransactionEventTag.Updated || entry.tag === TransactionEventTag.Interrupted) &&
      ContractAddress.equals(entry.address, vault)
    ) {
      for (const event of entry.events) {
        events.push(ContractEvent.toBuffer(event));
      }
    }
  }
  return events;
}

/** The vault's raw events in one block item, in order (none for most items). */
export function vaultEventsFromSummary(summary: Upward<BlockItemSummary>, vault: ContractAddress.Type): Uint8Array[] {
  if (!isKnown(summary)) {
    throw new UnknownEntryError("a block item could not be decoded; update the SDK");
  }
  if (summary.type !== TransactionSummaryType.AccountTransaction) {
    return [];
  }
  switch (summary.transactionType) {
    case TransactionKindString.InitContract: {
      const initialized = summary.contractInitialized;
      return ContractAddress.equals(initialized.address, vault) ? initialized.events.map((event) => fromHex(event)) : [];
    }
    case TransactionKindString.Update:
      return vaultEventsFromTrace(summary.events, vault);
    default:
      // Failed transactions log nothing; other kinds cannot touch the vault.
      return [];
  }
}
