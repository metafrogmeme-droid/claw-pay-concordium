import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { ContractAddress } from "@concordium/web-sdk";

import {
  accountCreationItem,
  failedItem,
  initItem,
  interrupted,
  resumed,
  transferItem,
  updateItem,
  updated,
} from "./fake-node.ts";
import { UnknownEntryError, vaultEventsFromSummary, vaultEventsFromTrace } from "./trace.ts";

const VAULT = ContractAddress.create(1, 0);
const REGISTRY = ContractAddress.create(0, 0);
const OTHER = ContractAddress.create(9, 0);
const e = (n: number): Uint8Array => new Uint8Array([n, n]);

describe("vaultEventsFromTrace", () => {
  test("collects the vault's events across Interrupted and Updated, in order", () => {
    const trace = [
      interrupted(VAULT, [e(1)]),
      updated(REGISTRY, [e(99)]),
      resumed(VAULT),
      updated(OTHER, [e(98)]),
      updated(VAULT, [e(2), e(3)]),
    ];
    assert.deepEqual(vaultEventsFromTrace(trace, VAULT), [e(1), e(2), e(3)]);
  });

  test("an undecodable entry is refused, not skipped", () => {
    assert.throws(() => vaultEventsFromTrace([updated(VAULT, [e(1)]), null], VAULT), UnknownEntryError);
  });
});

describe("vaultEventsFromSummary", () => {
  test("init, update and everything else", () => {
    assert.deepEqual(vaultEventsFromSummary(initItem(VAULT, [e(0)]), VAULT), [e(0)]);
    assert.deepEqual(vaultEventsFromSummary(initItem(OTHER, [e(0)]), VAULT), []);
    assert.deepEqual(vaultEventsFromSummary(updateItem([updated(VAULT, [e(5)])]), VAULT), [e(5)]);
    assert.deepEqual(vaultEventsFromSummary(failedItem(-6), VAULT), []);
    assert.deepEqual(vaultEventsFromSummary(transferItem(), VAULT), []);
    assert.deepEqual(vaultEventsFromSummary(accountCreationItem(), VAULT), []);
  });

  test("an undecodable block item is refused", () => {
    assert.throws(() => vaultEventsFromSummary(null, VAULT), UnknownEntryError);
    assert.throws(() => vaultEventsFromSummary(updateItem([null]), VAULT), UnknownEntryError);
  });
});
