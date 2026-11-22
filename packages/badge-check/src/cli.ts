#!/usr/bin/env node
/**
 * claw-pay-badge-check <agent-view.json> [--card <file>]
 *
 * The input file holds `{ "token_id": <n>, "agent_of_reply": "<hex>" }`: the
 * raw reply of the registry's `agentOf` for that token id. Without `--card`,
 * the card is fetched from the agent's `agent_uri` (HTTPS only).
 *
 * Exit codes: 0 eligible for the allowlist, 1 not eligible, 2 usage error or
 * unreadable input.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fromHex, toHex } from "@claw-pay-concordium/verifier";

import { decodeAgentView, type AgentView } from "./agent-view.ts";
import { checkBadge, type BadgeReport } from "./badge.ts";
import { fetchCard, type FetchCardOptions } from "./card.ts";

export const USAGE = "usage: claw-pay-badge-check <agent-view.json> [--card <file>]";

interface Args {
  input: string;
  card: string | null;
}

function parseArgs(args: readonly string[]): Args | null {
  let input: string | null = null;
  let card: string | null = null;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--card") {
      const value = args[i + 1];
      if (value === undefined || card !== null) {
        return null;
      }
      card = value;
      i++;
    } else if (arg !== undefined && !arg.startsWith("--") && input === null) {
      input = arg;
    } else {
      return null;
    }
  }
  return input === null ? null : { input, card };
}

function readInput(path: string): { tokenId: bigint; view: AgentView } {
  const json = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (typeof json !== "object" || json === null) {
    throw new Error("input must be a JSON object");
  }
  const record = json as Record<string, unknown>;
  const tokenId = record["token_id"];
  const reply = record["agent_of_reply"];
  if (typeof tokenId !== "number" || !Number.isSafeInteger(tokenId) || tokenId < 0) {
    throw new Error("token_id must be a non-negative integer");
  }
  if (typeof reply !== "string") {
    throw new Error("agent_of_reply must be a hex string");
  }
  return { tokenId: BigInt(tokenId), view: decodeAgentView(fromHex(reply)) };
}

function short(bytes: Uint8Array | null): string {
  return bytes === null ? "none" : `${toHex(bytes).slice(0, 16)}…`;
}

export function formatBadgeReport(view: AgentView, report: BadgeReport, cardSource: string): string[] {
  const lines = [
    `Agent ${String(report.tokenId)}`,
    `  status:        ${view.status}`,
    `  agent_uri:     ${view.agentUri ?? "none"}`,
    `  metadata_hash: ${view.metadataHash === null ? "none" : toHex(view.metadataHash)}`,
    `  card:          ${report.cardHash === null ? "not checked" : `${toHex(report.cardHash)} (${cardSource})`}`,
    `  card name:     ${report.cardName ?? "none"}`,
    `  agent_wallet:  ${short(view.agentWallet)}`,
  ];
  for (const issue of report.issues) {
    lines.push(`  ISSUE ${issue.code}: ${issue.message}`);
  }
  if (report.providerParams !== null) {
    const params = report.providerParams;
    const tokenId =
      params.tokenId <= BigInt(Number.MAX_SAFE_INTEGER)
        ? String(params.tokenId)
        : `"${String(params.tokenId)}"`;
    lines.push("ELIGIBLE: Verified by Concordium (card hash self-checked) and has a wallet.");
    lines.push(`add_provider parameter: {"token_id":${tokenId},"card_hash":"${params.cardHash}"}`);
  } else {
    lines.push(
      `NOT ELIGIBLE: ${report.verified ? "verified, but " : ""}${String(report.issues.length)} issue(s)`,
    );
  }
  return lines;
}

export async function run(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
  fetchOptions: FetchCardOptions = {},
): Promise<number> {
  const parsed = parseArgs(args);
  if (parsed === null) {
    err(USAGE);
    return 2;
  }
  let input;
  try {
    input = readInput(parsed.input);
  } catch (error) {
    err(`cannot read ${parsed.input}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }

  let cardBytes: Uint8Array | null = null;
  let cardError: string | undefined;
  let cardSource = "fetched from agent_uri";
  if (parsed.card !== null) {
    try {
      cardBytes = new Uint8Array(readFileSync(parsed.card));
      cardSource = `file ${parsed.card}`;
    } catch (error) {
      err(`cannot read ${parsed.card}: ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  } else if (input.view.agentUri !== null) {
    try {
      cardBytes = await fetchCard(input.view.agentUri, fetchOptions);
    } catch (error) {
      cardError = error instanceof Error ? error.message : String(error);
    }
  }

  const report = checkBadge({
    tokenId: input.tokenId,
    view: input.view,
    cardBytes,
    ...(cardError === undefined ? {} : { cardError }),
  });
  for (const line of formatBadgeReport(input.view, report, cardSource)) {
    out(line);
  }
  return report.eligible ? 0 : 1;
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
  process.exitCode = await run(
    process.argv.slice(2),
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
