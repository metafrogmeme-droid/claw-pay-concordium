/**
 * spend-policy: the client's `decide` core.
 *
 * `decide` is a pure function. Given the URL the agent actually requested, the
 * seller's x402 offers and what the agent has spent today, it allows one
 * `vault-exact` offer or denies with every reason that applies.
 *
 * This is a second layer. The vault enforces its own caps, allowlist, nonce
 * and invoice rules on chain whatever the client decides.
 */

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import {
  CONCORDIUM_TESTNET,
  MAX_TIMEOUT_SECONDS,
  SCHEME,
  parseRequirements,
  type VaultExactRequirements,
} from "@claw-pay-concordium/x402-vault";
import type { PaymentRequirements } from "@x402/core/types";

/** Which provider the agent expects to pay at an origin. */
export interface ProviderRule {
  /** A canonical origin, e.g. `https://seller.example`. */
  origin: string;
  /** The seller's registry token id. */
  provider: bigint;
  /** The seller's registry `agent_wallet`, Base58. Checked when set. */
  payTo?: string;
}

export interface SpendPolicy {
  /** The agent's GuardVault. */
  vault: ContractAddress.Type;
  /** Largest single payment, micro-CCD. */
  perPaymentMax: bigint;
  /** Largest total per fixed UTC day, micro-CCD (the vault's window). */
  dailyMax: bigint;
  /** Largest `maxTimeoutSeconds` the agent accepts, at most 60. */
  maxTimeoutSeconds: number;
  /** Execution energy for each `pay`, and the most the agent will sign. */
  maxEnergy: bigint;
  providers: readonly ProviderRule[];
  /** Trusted sponsor accounts, Base58. Any sponsor is accepted when unset. */
  feePayers?: readonly string[];
}

export type DenyReason =
  | "no_vault_exact_offer"
  | "unknown_origin"
  | "provider_mismatch"
  | "payto_mismatch"
  | "over_per_payment"
  | "over_daily"
  | "timeout_too_long"
  | "fee_payer_not_trusted";

export interface DecideInput {
  /** The URL the agent requested. The seller's own `resource.url` is ignored. */
  requestUrl: string;
  /** The `accepts` list of the seller's 402 answer. */
  offers: readonly PaymentRequirements[];
  /** What the receipt log counts as spent in the current UTC day, micro-CCD. */
  spentToday: bigint;
}

export type Decision =
  | { allow: true; requirements: PaymentRequirements; offer: VaultExactRequirements }
  | { allow: false; reasons: DenyReason[] };

function sameAccount(a: string, b: string): boolean {
  return AccountAddress.equals(AccountAddress.fromBase58(a), AccountAddress.fromBase58(b));
}

function originOf(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function reasonsFor(offer: VaultExactRequirements, rule: ProviderRule | undefined, policy: SpendPolicy, spentToday: bigint): DenyReason[] {
  const reasons: DenyReason[] = [];
  if (rule === undefined) {
    reasons.push("unknown_origin");
  } else {
    if (offer.provider !== rule.provider) {
      reasons.push("provider_mismatch");
    }
    if (rule.payTo !== undefined && !sameAccount(offer.payTo, rule.payTo)) {
      reasons.push("payto_mismatch");
    }
  }
  if (offer.amount > policy.perPaymentMax) {
    reasons.push("over_per_payment");
  }
  if (spentToday + offer.amount > policy.dailyMax) {
    reasons.push("over_daily");
  }
  if (offer.maxTimeoutSeconds > policy.maxTimeoutSeconds) {
    reasons.push("timeout_too_long");
  }
  const feePayers = policy.feePayers;
  if (feePayers !== undefined && !feePayers.some((trusted) => sameAccount(trusted, offer.feePayer))) {
    reasons.push("fee_payer_not_trusted");
  }
  return reasons;
}

/**
 * Decide whether to pay. Returns the first acceptable `vault-exact` offer on
 * testnet, or every reason the first such offer fails.
 */
export function decide(input: DecideInput, policy: SpendPolicy): Decision {
  const candidates: { requirements: PaymentRequirements; offer: VaultExactRequirements }[] = [];
  for (const requirements of input.offers) {
    if (requirements.scheme !== SCHEME || requirements.network !== CONCORDIUM_TESTNET) {
      continue;
    }
    try {
      candidates.push({ requirements, offer: parseRequirements(requirements) });
    } catch {
      // A malformed offer is never a candidate.
    }
  }
  const first = candidates[0];
  if (first === undefined) {
    return { allow: false, reasons: ["no_vault_exact_offer"] };
  }
  const origin = originOf(input.requestUrl);
  const rule = policy.providers.find((candidate) => candidate.origin === origin);
  for (const candidate of candidates) {
    if (reasonsFor(candidate.offer, rule, policy, input.spentToday).length === 0) {
      return { allow: true, ...candidate };
    }
  }
  return { allow: false, reasons: reasonsFor(first.offer, rule, policy, input.spentToday) };
}

/** Thrown when a policy file is not valid. */
export class PolicyError extends Error {
  override name = "PolicyError";
}

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;
const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"]);

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new PolicyError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function u64(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > U64_MAX) {
    throw new PolicyError(`${what} must be a decimal string (u64)`);
  }
  return BigInt(value);
}

function account(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new PolicyError(`${what} must be a Base58 account address`);
  }
  try {
    AccountAddress.fromBase58(value);
  } catch {
    throw new PolicyError(`${what} is not a valid account address`);
  }
  return value;
}

function origin(value: unknown, what: string): string {
  if (typeof value !== "string") {
    throw new PolicyError(`${what} must be an origin string`);
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new PolicyError(`${what} is not a URL`);
  }
  if (url.origin !== value) {
    throw new PolicyError(`${what} must be a bare origin like https://seller.example`);
  }
  if (url.protocol !== "https:" && !(url.protocol === "http:" && LOOPBACK.has(url.hostname))) {
    throw new PolicyError(`${what} must use https (plain http only on loopback)`);
  }
  return value;
}

/**
 * Validate a parsed policy file. Amounts, token ids and contract indexes are
 * decimal strings, so no precision is lost in JSON.
 */
export function parsePolicy(json: unknown): SpendPolicy {
  const raw = record(json, "policy");
  const vault = record(raw["vault"], "vault");
  const perPaymentMax = u64(raw["perPaymentMax"], "perPaymentMax");
  const dailyMax = u64(raw["dailyMax"], "dailyMax");
  if (perPaymentMax === 0n || perPaymentMax > dailyMax) {
    throw new PolicyError("perPaymentMax must be greater than 0 and at most dailyMax");
  }
  const maxTimeoutSeconds = raw["maxTimeoutSeconds"];
  if (
    typeof maxTimeoutSeconds !== "number" ||
    !Number.isInteger(maxTimeoutSeconds) ||
    maxTimeoutSeconds < 1 ||
    maxTimeoutSeconds > MAX_TIMEOUT_SECONDS
  ) {
    throw new PolicyError(`maxTimeoutSeconds must be an integer from 1 to ${String(MAX_TIMEOUT_SECONDS)}`);
  }
  const maxEnergy = u64(raw["maxEnergy"], "maxEnergy");
  if (maxEnergy === 0n) {
    throw new PolicyError("maxEnergy must be greater than 0");
  }
  const providersRaw = raw["providers"];
  if (!Array.isArray(providersRaw) || providersRaw.length === 0) {
    throw new PolicyError("providers must be a non-empty array");
  }
  const providers = providersRaw.map((entry: unknown, i): ProviderRule => {
    const item = record(entry, `providers[${String(i)}]`);
    const rule: ProviderRule = {
      origin: origin(item["origin"], `providers[${String(i)}].origin`),
      provider: u64(item["provider"], `providers[${String(i)}].provider`),
    };
    if (item["payTo"] !== undefined) {
      rule.payTo = account(item["payTo"], `providers[${String(i)}].payTo`);
    }
    return rule;
  });
  if (new Set(providers.map((rule) => rule.origin)).size !== providers.length) {
    throw new PolicyError("each origin may appear only once in providers");
  }
  const policy: SpendPolicy = {
    vault: ContractAddress.create(u64(vault["index"], "vault.index"), u64(vault["subindex"], "vault.subindex")),
    perPaymentMax,
    dailyMax,
    maxTimeoutSeconds,
    maxEnergy,
    providers,
  };
  const feePayersRaw = raw["feePayers"];
  if (feePayersRaw !== undefined) {
    if (!Array.isArray(feePayersRaw) || feePayersRaw.length === 0) {
      throw new PolicyError("feePayers, when set, must be a non-empty array");
    }
    policy.feePayers = feePayersRaw.map((entry: unknown, i) => account(entry, `feePayers[${String(i)}]`));
  }
  return policy;
}
