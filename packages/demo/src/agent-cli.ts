/**
 * `claw-pay-agent <url>`: fetch a URL as the agent, paying a `vault-exact`
 * 402 through the vault if every client-side guard agrees. Runs on the
 * operator box.
 *
 * Configuration is the agent client's (`CLAW_PAY_NETWORK`,
 * `CLAW_PAY_POLICY_FILE`, `CLAW_PAY_RECEIPT_LOG`, `CLAW_PAY_AGENT_KEY_FILE`)
 * plus `CLAW_PAY_NODE` for the testnet node.
 *
 * Exit codes: 0 a 2xx response; 1 the payment was refused or failed, or the
 * response is not 2xx; 2 a usage, config, key or node problem.
 */

import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  PaymentRefused,
  ReceiptLog,
  createPayingFetch,
  fileLogStore,
  loadConfig,
  type ClientConfig,
} from "@claw-pay-concordium/agent-client";
import { connectTestnetNode, nodeAgentChain, type NodeClient } from "@claw-pay-concordium/node-adapter";
import { formatCcd } from "@claw-pay-concordium/verifier";

export const AGENT_USAGE = "usage: claw-pay-agent <url>";
const BODY_PREVIEW = 2048;

export interface AgentDeps {
  env: Readonly<Record<string, string | undefined>>;
  loadConfig: (env: Readonly<Record<string, string | undefined>>) => ClientConfig;
  connect: (env: Readonly<Record<string, string | undefined>>) => Promise<NodeClient>;
  openLog: (path: string) => ReceiptLog;
  fetch?: typeof globalThis.fetch;
  now?: () => number;
  out: (line: string) => void;
  err: (line: string) => void;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export async function runAgent(argv: readonly string[], deps: AgentDeps): Promise<number> {
  const [url, ...rest] = argv;
  if (url === undefined || rest.length > 0 || !URL.canParse(url)) {
    deps.err(AGENT_USAGE);
    return 2;
  }
  let config: ClientConfig;
  let client: NodeClient;
  let log: ReceiptLog;
  try {
    config = deps.loadConfig(deps.env);
    client = await deps.connect(deps.env);
    log = deps.openLog(config.receiptLogPath);
  } catch (error) {
    deps.err(message(error));
    return 2;
  }

  const payFetch = createPayingFetch({
    policy: config.policy,
    agent: config.agent,
    sign: config.sign,
    chain: nodeAgentChain(client, config.policy.vault, config.agent),
    log,
    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
    ...(deps.now === undefined ? {} : { now: deps.now }),
  });
  const before = log.entries.length;
  let response: Response;
  try {
    response = await payFetch(url);
  } catch (error) {
    if (error instanceof PaymentRefused) {
      deps.err(`payment refused by ${error.layer}: ${error.reasons.join(", ")}`);
      return 1;
    }
    deps.err(`request failed: ${message(error)}`);
    return 1;
  }

  deps.out(`HTTP ${String(response.status)}`);
  const entries = log.entries.slice(before);
  for (const entry of entries) {
    const outcome = entry.transaction === undefined ? (entry.errorReason ?? "") : `transaction ${entry.transaction}`;
    deps.out(`${entry.kind} ${formatCcd(BigInt(entry.amount))} invoice ${entry.invoiceHash.slice(0, 16)}… ${outcome}`.trimEnd());
  }
  const body = await response.text();
  if (body !== "") {
    deps.out(body.length > BODY_PREVIEW ? `${body.slice(0, BODY_PREVIEW)}…` : body);
  }
  const failed = entries.some((entry) => entry.kind === "failed");
  return response.ok && !failed ? 0 : 1;
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
  runAgent(process.argv.slice(2), {
    env: process.env,
    loadConfig: (env) => loadConfig(env),
    connect: (env) => connectTestnetNode(env),
    openLog: (path) => ReceiptLog.open(fileLogStore(path)),
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
