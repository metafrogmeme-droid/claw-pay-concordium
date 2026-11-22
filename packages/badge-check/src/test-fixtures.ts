/** Test helpers: the shared fixtures produced by the Rust contract tests. */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { fromHex } from "@claw-pay-concordium/verifier";

export const AGENT_VIEWS_PATH = fileURLToPath(
  new URL("../../../fixtures/agent-views.v1.json", import.meta.url),
);
export const CARD_PATH = fileURLToPath(
  new URL("../../../fixtures/agent-card.example.json", import.meta.url),
);

interface AgentEntry {
  token_id: number;
  note: string;
  agent_of_reply: string;
}

const AGENTS = (JSON.parse(readFileSync(AGENT_VIEWS_PATH, "utf8")) as { agents: AgentEntry[] })
  .agents;

/** Token ids in the fixture: verified with wallet, revoked, no wallet. */
export const VERIFIED = 10;
export const REVOKED = 11;
export const NO_WALLET = 12;

export function agentEntry(tokenId: number): AgentEntry {
  const entry = AGENTS.find((agent) => agent.token_id === tokenId);
  if (entry === undefined) {
    throw new Error(`no fixture entry for token ${String(tokenId)}`);
  }
  return entry;
}

export function agentReply(tokenId: number): Uint8Array {
  return fromHex(agentEntry(tokenId).agent_of_reply);
}

export function exampleCard(): Uint8Array {
  return new Uint8Array(readFileSync(CARD_PATH));
}
