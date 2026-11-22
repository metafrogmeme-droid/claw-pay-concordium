/**
 * Test-only: an in-memory stand-in for a Concordium node, returning objects
 * in the SDK's shapes. Nothing here opens a connection. Exported as
 * `@claw-pay-concordium/node-adapter/test-support` for other packages'
 * offline tests; never use it in a real client.
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  AccountAddress,
  BlockHash,
  ContractAddress,
  ContractEvent,
  RejectReasonTag,
  ReturnValue,
  SequenceNumber,
  TransactionEventTag,
  TransactionHash,
  TransactionKindString,
  TransactionSummaryType,
  type AccountInfo,
  type BlockItemSummary,
  type BlockItemSummaryInBlock,
  type ContractTraceEvent,
  type InvokeContractResult,
  type Upward,
} from "@concordium/web-sdk";
import type { Transaction } from "@concordium/web-sdk/transactions";
import { fromHex } from "@claw-pay-concordium/verifier";

import type { NodeClient } from "./node-client.ts";
import { TESTNET_GENESIS_PREFIX } from "./node-client.ts";

const VIEW_FIXTURE = fileURLToPath(new URL("../../../fixtures/vault-view.v1.json", import.meta.url));

export interface ViewFixture {
  bytes: string;
  fields: Record<string, unknown>;
}

export function viewFixture(): ViewFixture {
  return JSON.parse(readFileSync(VIEW_FIXTURE, "utf8")) as ViewFixture;
}

function u64le(value: bigint): Uint8Array {
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

/** The fixture's view bytes with some fields replaced. */
export function viewBytes(patch: { agent?: AccountAddress.Type; nextNonce?: bigint; currentDay?: bigint; spentToday?: bigint } = {}): Uint8Array {
  const bytes = fromHex(viewFixture().bytes);
  if (patch.agent !== undefined) {
    bytes.set(patch.agent.decodedAddress, 32);
  }
  if (patch.nextNonce !== undefined) {
    bytes.set(u64le(patch.nextNonce), 97);
  }
  if (patch.currentDay !== undefined) {
    bytes.set(u64le(patch.currentDay), 105);
  }
  if (patch.spentToday !== undefined) {
    bytes.set(u64le(patch.spentToday), 113);
  }
  return bytes;
}

function buffer(bytes: Uint8Array): ArrayBuffer {
  const copy = new Uint8Array(bytes.length);
  copy.set(bytes);
  return copy.buffer;
}

export const TESTNET_GENESIS = TESTNET_GENESIS_PREFIX + "0".repeat(32);

export function blockHash(n: number): BlockHash.Type {
  return BlockHash.fromHexString(n.toString(16).padStart(64, "0"));
}

// Trace entries and block items, in the SDK's shapes (only the fields read).

export function updated(vault: ContractAddress.Type, events: Uint8Array[]): ContractTraceEvent {
  return {
    tag: TransactionEventTag.Updated,
    address: vault,
    events: events.map((event) => ContractEvent.fromBuffer(buffer(event))),
  } as unknown as ContractTraceEvent;
}

export function interrupted(vault: ContractAddress.Type, events: Uint8Array[]): ContractTraceEvent {
  return {
    tag: TransactionEventTag.Interrupted,
    address: vault,
    events: events.map((event) => ContractEvent.fromBuffer(buffer(event))),
  } as unknown as ContractTraceEvent;
}

export function resumed(vault: ContractAddress.Type): ContractTraceEvent {
  return { tag: TransactionEventTag.Resumed, address: vault, success: true } as unknown as ContractTraceEvent;
}

export function updateItem(trace: Upward<ContractTraceEvent>[]): BlockItemSummary {
  return { type: TransactionSummaryType.AccountTransaction, transactionType: TransactionKindString.Update, events: trace } as unknown as BlockItemSummary;
}

export function initItem(vault: ContractAddress.Type, events: Uint8Array[]): BlockItemSummary {
  return {
    type: TransactionSummaryType.AccountTransaction,
    transactionType: TransactionKindString.InitContract,
    contractInitialized: { tag: TransactionEventTag.ContractInitialized, address: vault, events: events.map((event) => Buffer.from(event).toString("hex")) },
  } as unknown as BlockItemSummary;
}

export function failedItem(rejectReason: number): BlockItemSummary {
  return {
    type: TransactionSummaryType.AccountTransaction,
    transactionType: TransactionKindString.Failed,
    rejectReason: { tag: RejectReasonTag.RejectedReceive, rejectReason },
  } as unknown as BlockItemSummary;
}

export function transferItem(): BlockItemSummary {
  return { type: TransactionSummaryType.AccountTransaction, transactionType: TransactionKindString.Transfer } as unknown as BlockItemSummary;
}

export function accountCreationItem(): BlockItemSummary {
  return { type: TransactionSummaryType.AccountCreation } as unknown as BlockItemSummary;
}

export interface FakeBlock {
  height: bigint;
  hash: BlockHash.Type;
  items: Upward<BlockItemSummary>[];
}

export interface FakeNodeOptions {
  genesis?: string;
  /** View bytes by block hash hex; "latest" for the last finalized block. */
  views?: Map<string, Uint8Array>;
  pay?: (invoker: AccountAddress.Type | undefined, message: Uint8Array) => InvokeContractResult;
  /** Any entrypoint; checked first. Return undefined to fall through to view/pay. */
  invoke?: (call: { method: string; invoker: AccountAddress.Type | undefined; message: Uint8Array; amount: bigint }) => InvokeContractResult | undefined;
  accounts?: Map<string, AccountInfo>;
  nextNonce?: bigint;
  blocks?: FakeBlock[];
  lastFinalizedHeight?: bigint;
  finalization?: (sent: Transaction.Finalized) => Promise<BlockItemSummaryInBlock>;
}

export type FakeNode = NodeClient & { calls: string[]; sent: Transaction.Finalized[] };

export function fakeNode(options: FakeNodeOptions = {}): FakeNode {
  const calls: string[] = [];
  const sent: Transaction.Finalized[] = [];
  const blocks = options.blocks ?? [];
  const client = {
    calls,
    sent,
    getConsensusStatus: () => {
      calls.push("getConsensusStatus");
      return Promise.resolve({
        genesisBlock: BlockHash.fromHexString(options.genesis ?? TESTNET_GENESIS),
        lastFinalizedBlockHeight: options.lastFinalizedHeight ?? blocks.at(-1)?.height ?? 0n,
      });
    },
    getAccountInfo: (account: AccountAddress.Type) => {
      calls.push("getAccountInfo");
      const info = options.accounts?.get(AccountAddress.toBase58(account));
      return info === undefined ? Promise.reject(new Error("account not found")) : Promise.resolve(info);
    },
    getNextAccountNonce: () => {
      calls.push("getNextAccountNonce");
      return Promise.resolve({ nonce: SequenceNumber.create(options.nextNonce ?? 1n), allFinal: true });
    },
    invokeContract: (
      context: { method: { toString(): string }; invoker?: AccountAddress.Type; parameter?: { buffer: Uint8Array }; amount?: { microCcdAmount: bigint } },
      block?: BlockHash.Type,
    ): Promise<InvokeContractResult> => {
      calls.push(`invokeContract:${context.method.toString()}`);
      if (options.invoke !== undefined) {
        const result = options.invoke({
          method: context.method.toString(),
          invoker: context.invoker,
          message: context.parameter === undefined ? new Uint8Array() : new Uint8Array(context.parameter.buffer),
          amount: context.amount?.microCcdAmount ?? 0n,
        });
        if (result !== undefined) {
          return Promise.resolve(result);
        }
      }
      if (context.method.toString() === "guard_vault.view") {
        const key = block === undefined ? "latest" : BlockHash.toHexString(block);
        const bytes = options.views?.get(key) ?? options.views?.get("latest") ?? viewBytes();
        return Promise.resolve({ tag: "success", usedEnergy: 1n, events: [], returnValue: ReturnValue.fromBuffer(buffer(bytes)) } as unknown as InvokeContractResult);
      }
      if (options.pay === undefined) {
        return Promise.reject(new Error("no pay handler"));
      }
      const message = context.parameter === undefined ? new Uint8Array() : new Uint8Array(context.parameter.buffer);
      return Promise.resolve(options.pay(context.invoker, message));
    },
    sendTransaction: (transaction: Transaction.Finalized) => {
      calls.push("sendTransaction");
      sent.push(transaction);
      return Promise.resolve(TransactionHash.fromHexString("ab".repeat(32)));
    },
    waitForTransactionFinalization: () => {
      calls.push("waitForTransactionFinalization");
      const last = sent.at(-1);
      if (options.finalization === undefined || last === undefined) {
        return Promise.reject(new Error("Function timed out."));
      }
      return options.finalization(last);
    },
    getBlocksAtHeight: (height: bigint) => {
      calls.push("getBlocksAtHeight");
      return Promise.resolve(blocks.filter((block) => block.height === height).map((block) => block.hash));
    },
    getBlockTransactionEvents: (hash?: BlockHash.Type) => {
      calls.push("getBlockTransactionEvents");
      const block = blocks.find((candidate) => hash !== undefined && BlockHash.equals(candidate.hash, hash));
      const items = block?.items ?? [];
      return (async function* () {
        for (const item of items) {
          await Promise.resolve();
          yield item;
        }
      })();
    },
  };
  return client as unknown as FakeNode;
}

export function successInvoke(trace: ContractTraceEvent[]): InvokeContractResult {
  return { tag: "success", usedEnergy: 1n, events: trace } as unknown as InvokeContractResult;
}

export function rejectedInvoke(code: number): InvokeContractResult {
  return { tag: "failure", usedEnergy: 1n, reason: { tag: RejectReasonTag.RejectedReceive, rejectReason: code } } as unknown as InvokeContractResult;
}

const EVENTS_FIXTURE = fileURLToPath(new URL("../../../fixtures/vault-events.v1.json", import.meta.url));

/** The golden events file (simulated chain), as parsed JSON. */
export function goldenEventsJson(): { vault: { index: number; subindex: number }; view: { next_nonce: number; receipt_head: string }; events: string[] } {
  return JSON.parse(readFileSync(EVENTS_FIXTURE, "utf8")) as ReturnType<typeof goldenEventsJson>;
}

/**
 * A fake finalized chain, heights 100..110, carrying the 13 golden vault
 * events spread over blocks: the init, an empty block, another contract's
 * events, a failed transaction, a `pay` whose events sit in an `Interrupted`
 * entry, and several updates in one block. The view at height 110 is the
 * fixture's; the "latest" view differs, to show the export reads at 110.
 */
export function goldenChain(options: { lastFinalizedHeight?: bigint } = {}): { node: FakeNode; vault: ContractAddress.Type; events: Uint8Array[] } {
  const golden = goldenEventsJson();
  const vault = ContractAddress.create(golden.vault.index, golden.vault.subindex);
  const registry = ContractAddress.create(0, 0);
  const other = ContractAddress.create(9, 0);
  const ev = golden.events.map((event) => fromHex(event));
  const at = (i: number): Uint8Array => {
    const event = ev[i];
    if (event === undefined) {
      throw new Error(`no golden event ${String(i)}`);
    }
    return event;
  };
  const items: Upward<BlockItemSummary>[][] = [
    [transferItem(), initItem(vault, [at(0)])], // 100
    [], // 101
    [updateItem([updated(vault, [at(1)])]), updateItem([updated(other, [new Uint8Array([1, 2, 3])])])], // 102
    [failedItem(-6), updateItem([updated(vault, [at(2)])])], // 103
    [updateItem([interrupted(vault, []), updated(registry, []), resumed(vault), updated(vault, [at(3)])])], // 104
    [updateItem([interrupted(vault, [at(4)]), updated(registry, []), resumed(vault), updated(vault, [])]), updateItem([updated(vault, [at(5)])])], // 105
    [updateItem([updated(vault, [at(6)])]), updateItem([updated(vault, [at(7)])]), updateItem([updated(vault, [at(8)])])], // 106
    [accountCreationItem()], // 107
    [updateItem([interrupted(vault, []), updated(registry, []), resumed(vault), updated(vault, [at(9)])]), updateItem([updated(vault, [at(10)])])], // 108
    [updateItem([interrupted(vault, []), updated(registry, []), resumed(vault), updated(vault, [at(11)])])], // 109
    [updateItem([updated(vault, [at(12)])])], // 110
  ];
  const blocks: FakeBlock[] = items.map((blockItems, i) => ({ height: BigInt(100 + i), hash: blockHash(100 + i), items: blockItems }));
  const node = fakeNode({
    blocks,
    lastFinalizedHeight: options.lastFinalizedHeight ?? 110n,
    views: new Map([
      [BlockHash.toHexString(blockHash(110)), fromHex(viewFixture().bytes)],
      ["latest", viewBytes({ nextNonce: 99n })],
    ]),
  });
  return { node, vault, events: ev };
}
