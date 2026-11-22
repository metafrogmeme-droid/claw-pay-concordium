/**
 * The badge check: is this registry agent "Verified by Concordium", and can
 * the vault owner allowlist it?
 *
 * Verified: the agent is Active in the CIS-8004 registry and its Agent Card,
 * from `agent_uri`, hashes (SHA-256) to the on-chain `metadata_hash`.
 * Eligible: verified, and the agent has an `agent_wallet`, because the vault
 * pays only to that wallet.
 */

import { createHash } from "node:crypto";

import { equalBytes, toHex } from "@claw-pay-concordium/verifier";

import type { AgentView } from "./agent-view.ts";
import { checkCardShape } from "./card.ts";

export type BadgeIssueCode =
  | "token-mismatch"
  | "not-active"
  | "no-agent-uri"
  | "no-card-hash"
  | "card-unavailable"
  | "card-hash-mismatch"
  | "card-malformed"
  | "no-agent-wallet";

export interface BadgeIssue {
  code: BadgeIssueCode;
  message: string;
}

export interface BadgeInput {
  /** The registry token id that was asked for. */
  tokenId: bigint;
  view: AgentView;
  /** The card bytes, or null if they could not be obtained. */
  cardBytes: Uint8Array | null;
  /** Why the card could not be obtained, when `cardBytes` is null. */
  cardError?: string;
}

export interface BadgeReport {
  tokenId: bigint;
  verified: boolean;
  eligible: boolean;
  cardName: string | null;
  /** SHA-256 of the card bytes that were checked. */
  cardHash: Uint8Array | null;
  issues: BadgeIssue[];
  /** The `add_provider` parameter, when eligible. */
  providerParams: { tokenId: bigint; cardHash: string } | null;
}

function sha256(bytes: Uint8Array): Uint8Array {
  return new Uint8Array(createHash("sha256").update(bytes).digest());
}

export function checkBadge(input: BadgeInput): BadgeReport {
  const { tokenId, view, cardBytes } = input;
  const issues: BadgeIssue[] = [];
  const issue = (code: BadgeIssueCode, message: string): void => {
    issues.push({ code, message });
  };

  if (view.tokenId !== tokenId) {
    issue(
      "token-mismatch",
      `asked for token ${String(tokenId)}, the reply is for ${String(view.tokenId)}`,
    );
  }
  if (view.status !== "Active") {
    issue("not-active", `registry status is ${view.status}`);
  }
  if (view.agentUri === null) {
    issue("no-agent-uri", "the agent has no agent_uri, so there is no card to check");
  }
  if (view.metadataHash === null) {
    issue("no-card-hash", "the agent has no metadata_hash on chain");
  }

  let cardHash: Uint8Array | null = null;
  let cardName: string | null = null;
  if (cardBytes === null) {
    if (view.agentUri !== null) {
      issue("card-unavailable", input.cardError ?? "the card could not be obtained");
    }
  } else {
    cardHash = sha256(cardBytes);
    if (view.metadataHash !== null && !equalBytes(cardHash, view.metadataHash)) {
      issue("card-hash-mismatch", "the card's SHA-256 differs from the on-chain metadata_hash");
    }
    const shape = checkCardShape(cardBytes);
    cardName = shape.name;
    for (const problem of shape.problems) {
      issue("card-malformed", problem);
    }
  }

  const verified = issues.length === 0;
  if (view.agentWallet === null) {
    issue("no-agent-wallet", "the agent has no agent_wallet, and the vault pays only to it");
  }
  const eligible = verified && view.agentWallet !== null;

  return {
    tokenId,
    verified,
    eligible,
    cardName,
    cardHash,
    issues,
    providerParams:
      eligible && cardHash !== null ? { tokenId, cardHash: toHex(cardHash) } : null,
  };
}
