/**
 * `claw-pay-export`: export a vault's finalized events from a Concordium
 * testnet node for `claw-pay-verify`, and optionally reconcile the agent's
 * local receipt log against them. Runs on the operator box.
 *
 * Exit codes: 0 done (and, with --log, nothing to look at); 1 the reconcile
 * report needs attention; 2 usage error, wrong network or export failure.
 */

import { realpathSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { ContractAddress } from "@concordium/web-sdk";
import { ReceiptLog, assertTestnet, fileLogStore, type LogEntry } from "@claw-pay-concordium/agent-client";
import { formatCcd, parseEventsFile } from "@claw-pay-concordium/verifier";

import { exportVaultEvents, type ExportClient } from "./exporter.ts";
import { connectTestnetNode } from "./node-client.ts";
import { needsAttention, reconcile } from "./reconcile.ts";

export const USAGE =
  "usage: claw-pay-export --vault <index>[,<subindex>] --from-height <h> [--to-height <h>] --out <events.json> [--log <receipts.jsonl>]";

export interface CliDeps {
  env: Readonly<Record<string, string | undefined>>;
  connect: (env: Readonly<Record<string, string | undefined>>) => Promise<ExportClient>;
  writeFile: (path: string, text: string) => void;
  readLog: (path: string) => readonly LogEntry[];
  out: (line: string) => void;
  err: (line: string) => void;
}

interface Args {
  vault: ContractAddress.Type;
  fromHeight: bigint;
  toHeight?: bigint;
  out: string;
  log?: string;
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;

function parseArgs(argv: readonly string[]): Args | string {
  const values = new Map<string, string>();
  for (let i = 0; i < argv.length; i += 2) {
    const flag = argv[i] ?? "";
    const value = argv[i + 1];
    if (!["--vault", "--from-height", "--to-height", "--out", "--log"].includes(flag) || value === undefined || values.has(flag)) {
      return `unexpected argument ${JSON.stringify(flag)}`;
    }
    values.set(flag, value);
  }
  const vault = values.get("--vault");
  const from = values.get("--from-height");
  const out = values.get("--out");
  if (vault === undefined || from === undefined || out === undefined) {
    return "--vault, --from-height and --out are required";
  }
  const [index = "", subindex = "0", ...rest] = vault.split(",");
  if (!DECIMAL.test(index) || !DECIMAL.test(subindex) || rest.length > 0) {
    return "--vault must be <index> or <index>,<subindex>";
  }
  if (!DECIMAL.test(from)) {
    return "--from-height must be a block height";
  }
  const args: Args = { vault: ContractAddress.create(BigInt(index), BigInt(subindex)), fromHeight: BigInt(from), out };
  const to = values.get("--to-height");
  if (to !== undefined) {
    if (!DECIMAL.test(to)) {
      return "--to-height must be a block height";
    }
    args.toHeight = BigInt(to);
  }
  const log = values.get("--log");
  if (log !== undefined) {
    args.log = log;
  }
  return args;
}

export async function run(argv: readonly string[], deps: CliDeps): Promise<number> {
  try {
    assertTestnet(deps.env["CLAW_PAY_NETWORK"]);
  } catch (error) {
    deps.err(error instanceof Error ? error.message : String(error));
    return 2;
  }
  const args = parseArgs(argv);
  if (typeof args === "string") {
    deps.err(args);
    deps.err(USAGE);
    return 2;
  }

  let result;
  try {
    const client = await deps.connect(deps.env);
    result = await exportVaultEvents({
      client,
      vault: args.vault,
      fromHeight: args.fromHeight,
      ...(args.toHeight === undefined ? {} : { toHeight: args.toHeight }),
    });
    deps.writeFile(args.out, `${JSON.stringify(result.file, null, 2)}\n`);
  } catch (error) {
    deps.err(`export failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  deps.out(
    `exported ${String(result.file.events.length)} events from finalized blocks ${String(result.fromHeight)}..${String(result.toHeight)} to ${args.out}`,
  );
  deps.out(`view at block ${result.blockHash}: next_nonce ${String(result.file.view.next_nonce)}`);
  deps.out(`check it with: claw-pay-verify ${args.out}`);

  if (args.log === undefined) {
    return 0;
  }
  let report;
  try {
    report = reconcile(deps.readLog(args.log), parseEventsFile(result.file));
  } catch (error) {
    deps.err(`reconcile failed: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const line = (label: string, items: readonly { invoiceHash: string; amount: bigint }[]): void => {
    deps.out(`${label}: ${String(items.length)}`);
    for (const item of items) {
      deps.out(`  ${item.invoiceHash.slice(0, 16)}…  ${formatCcd(item.amount)}`);
    }
  };
  line("confirmed on chain", report.confirmed);
  line("settled locally but not on chain", report.missingOnChain);
  line("landed despite a local failure", report.landedDespiteFailure);
  line("receipt disagrees with the log", report.mismatched);
  line("on chain but not in the log", report.notInLog);
  return needsAttention(report) ? 1 : 0;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  run(process.argv.slice(2), {
    env: process.env,
    connect: (env) => connectTestnetNode(env),
    writeFile: (path, text) => {
      writeFileSync(path, text);
    },
    readLog: (path) => ReceiptLog.open(fileLogStore(path)).entries,
    out: (line) => {
      console.log(line);
    },
    err: (line) => {
      console.error(line);
    },
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 2;
    },
  );
}
