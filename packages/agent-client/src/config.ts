/**
 * Start-up configuration from the environment, testnet guard first.
 *
 * | Variable | Meaning |
 * |---|---|
 * | `CLAW_PAY_NETWORK` | Must be exactly `testnet`. Checked before anything else is read. |
 * | `CLAW_PAY_POLICY_FILE` | The spend policy (JSON). |
 * | `CLAW_PAY_RECEIPT_LOG` | The local receipt log (JSON lines, created with mode 600). |
 * | `CLAW_PAY_AGENT_KEY_FILE` | The agent's testnet wallet export, mode 600. |
 *
 * The agent key goes straight into the capped signer; the returned config
 * holds only the capped `sign` function, never the raw key.
 */

import { readFileSync } from "node:fs";

import type { AccountAddress } from "@concordium/web-sdk";
import type { TransactionSigner } from "@claw-pay-concordium/x402-vault";

import { createCappedSigner } from "./capped-signer.ts";
import { loadAgentKey, type KeyFs } from "./keys.ts";
import { assertTestnet, type AllowedNetwork } from "./network.ts";
import { PolicyError, parsePolicy, type SpendPolicy } from "./spend-policy.ts";

export interface ClientConfig {
  network: AllowedNetwork;
  policy: SpendPolicy;
  receiptLogPath: string;
  agent: AccountAddress.Type;
  /** The capped signer. */
  sign: TransactionSigner;
}

export interface ConfigDeps {
  fs?: KeyFs;
  uid?: number;
  readPolicy?: (path: string) => string;
  now?: () => number;
}

/** Thrown when a required variable is missing. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

function required(env: Readonly<Record<string, string | undefined>>, name: string): string {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new ConfigError(`${name} is not set`);
  }
  return value;
}

export function loadConfig(env: Readonly<Record<string, string | undefined>>, deps: ConfigDeps = {}): ClientConfig {
  const network = env["CLAW_PAY_NETWORK"];
  assertTestnet(network);
  const policyPath = required(env, "CLAW_PAY_POLICY_FILE");
  const receiptLogPath = required(env, "CLAW_PAY_RECEIPT_LOG");
  let policyJson: unknown;
  try {
    policyJson = JSON.parse((deps.readPolicy ?? ((path) => readFileSync(path, "utf8")))(policyPath));
  } catch {
    throw new PolicyError("CLAW_PAY_POLICY_FILE could not be read as JSON");
  }
  const policy = parsePolicy(policyJson);
  const keyOptions: { fs?: KeyFs; uid?: number } = {};
  if (deps.fs !== undefined) {
    keyOptions.fs = deps.fs;
  }
  if (deps.uid !== undefined) {
    keyOptions.uid = deps.uid;
  }
  const key = loadAgentKey(env, keyOptions);
  const signerConfig = {
    signer: key.signer,
    agent: key.address,
    vault: policy.vault,
    perPaymentMax: policy.perPaymentMax,
    maxEnergy: policy.maxEnergy,
    ...(deps.now === undefined ? {} : { now: deps.now }),
  };
  return {
    network,
    policy,
    receiptLogPath,
    agent: key.address,
    sign: createCappedSigner(signerConfig),
  };
}
