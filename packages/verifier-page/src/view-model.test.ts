import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";
import { fileURLToPath } from "node:url";

import { checkFile } from "./pipeline.ts";
import { toViewModel } from "./view-model.ts";

const GOLDEN = readFileSync(fileURLToPath(new URL("../../../fixtures/vault-events.v1.json", import.meta.url)), "utf8");

describe("toViewModel", () => {
  test("a verified vault: headline, one row per receipt, amounts in CCD", () => {
    const { file, report } = checkFile(GOLDEN);
    const view = toViewModel(file, report);
    assert.equal(view.ok, true);
    assert.equal(view.headline, "Verified");
    assert.match(view.summary, /4 receipts from 13 events/);
    assert.deepEqual(view.receipts.map((row) => row.amount), ["3.000000 CCD", "5.000000 CCD", "4.000000 CCD", "2.000000 CCD"]);
    assert.deepEqual(view.receipts.map((row) => row.nonce), ["0", "1", "2", "3"]);
    const first = view.receipts[0];
    assert.ok(first !== undefined);
    assert.match(first.time, /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/);
    assert.ok(first.payeeFull.startsWith(first.payee.slice(0, 8)) && first.payee.includes("…"));
    assert.equal(view.issues.length, 0);
  });

  test("a failing vault lists its issues", () => {
    const json = JSON.parse(GOLDEN) as { view: { next_nonce: number } };
    json.view.next_nonce = 9;
    const { file, report } = checkFile(JSON.stringify(json));
    const view = toViewModel(file, report);
    assert.equal(view.ok, false);
    assert.equal(view.headline, "Not verified");
    assert.ok(view.issues.length > 0);
    assert.match(view.issues.join("\n"), /file: /);
  });
});
