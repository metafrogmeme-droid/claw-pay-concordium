/**
 * `claw-pay-owner`: the vault owner's testnet CLI. Runs on the operator box.
 *
 * Every state-changing command is a dry run unless `--send` is given:
 * - the plan is printed (contract, entrypoint, decoded parameter, amount);
 * - updates are invoked against the node as the owner first, showing the
 *   energy used, or the vault's reject code and name;
 * - `--send` is refused when the dry run rejected.
 *
 * Exit codes: 0 ok; 1 rejected (dry run or on chain), or a deploy whose
 * module reference does not match; 2 usage error, wrong network, or a key or
 * node problem.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { AccountAddress, CcdAmount, Energy, Parameter, ReceiveName, ReturnValue } from "@concordium/web-sdk";
import { assertTestnet, loadKeyFile } from "@claw-pay-concordium/agent-client";
import { connectTestnetNode, readVaultView, type NodeClient } from "@claw-pay-concordium/node-adapter";
import { formatCcd, toHex } from "@claw-pay-concordium/verifier";

import { describeRejectCode } from "./errors.ts";
import { CONTRACT_NAME, USAGE, UsageError, parseCommand, type Plan } from "./plan.ts";
import { nextNonce, signPlan, submit, type Owner, type SendablePlan } from "./send.ts";

export const OWNER_KEY_VAR = "CLAW_PAY_OWNER_KEY_FILE";
/** Energy allowed for the dry run itself. */
const DRY_RUN_ENERGY = 100_000n;
const FINALIZATION_TIMEOUT_MS = 120_000;

export type OwnerClient = Pick<NodeClient, "invokeContract" | "getNextAccountNonce" | "sendTransaction" | "waitForTransactionFinalization">;

export interface OwnerCliDeps {
  env: Readonly<Record<string, string | undefined>>;
  loadOwner: (env: Readonly<Record<string, string | undefined>>) => Owner;
  connect: (env: Readonly<Record<string, string | undefined>>) => Promise<OwnerClient>;
  readFile: (path: string) => Uint8Array;
  out: (line: string) => void;
  err: (line: string) => void;
  now?: () => number;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** The energy to send: --energy, or what the dry run used plus 20%. */
export function energyFor(used: bigint): bigint {
  return used + used / 5n + 100n;
}

async function readCommand(plan: Extract<Plan, { kind: "view" | "provider" }>, client: OwnerClient, out: (line: string) => void): Promise<number> {
  if (plan.kind === "view") {
    const view = await readVaultView(client, plan.vault);
    out(`vault <${String(plan.vault.index)},${String(plan.vault.subindex)}>`);
    out(`  owner        ${AccountAddress.toBase58(view.owner)}`);
    out(`  agent        ${AccountAddress.toBase58(view.agent)}`);
    out(`  registry     <${String(view.registry.index)},${String(view.registry.subindex)}>`);
    out(`  caps         per-tx ${formatCcd(view.perTxCap)}, daily ${formatCcd(view.dailyCap)}`);
    out(`  paused       ${String(view.paused)}`);
    out(`  balance      ${formatCcd(view.balance)}`);
    out(`  spent today  ${formatCcd(view.spentToday)} (UTC day ${String(view.currentDay)})`);
    out(`  next nonce   ${String(view.nextNonce)}`);
    out(`  receipt head ${toHex(view.receiptHead)}`);
    return 0;
  }
  const token = new Uint8Array(8);
  new DataView(token.buffer).setBigUint64(0, plan.tokenId, true);
  const result = await client.invokeContract({
    contract: plan.vault,
    method: ReceiveName.fromString(`${CONTRACT_NAME}.provider`),
    parameter: Parameter.fromBuffer(token.buffer),
    energy: Energy.create(DRY_RUN_ENERGY),
  });
  if (result.tag !== "success" || result.returnValue === undefined) {
    throw new Error("the provider lookup failed");
  }
  const bytes = ReturnValue.toBuffer(result.returnValue);
  if (bytes[0] === 1 && bytes.length === 33) {
    out(`registry agent ${String(plan.tokenId)} is allowlisted with card hash ${toHex(bytes.slice(1))}`);
  } else if (bytes[0] === 0 && bytes.length === 1) {
    out(`registry agent ${String(plan.tokenId)} is not allowlisted`);
  } else {
    throw new Error("unexpected provider reply");
  }
  return 0;
}

export async function run(argv: readonly string[], deps: OwnerCliDeps): Promise<number> {
  const { out, err } = deps;
  try {
    assertTestnet(deps.env["CLAW_PAY_NETWORK"]);
  } catch (error) {
    err(message(error));
    return 2;
  }
  let parsed;
  try {
    parsed = parseCommand(argv, deps.readFile);
  } catch (error) {
    err(message(error));
    err(USAGE);
    return 2;
  }
  const { plan, send } = parsed;

  let client: OwnerClient;
  let owner: Owner | undefined;
  try {
    if (plan.kind !== "view" && plan.kind !== "provider") {
      owner = deps.loadOwner(deps.env);
    }
    client = await deps.connect(deps.env);
  } catch (error) {
    err(message(error));
    return 2;
  }

  try {
    if (plan.kind === "view" || plan.kind === "provider") {
      return await readCommand(plan, client, out);
    }
    if (owner === undefined) {
      throw new Error("no owner key");
    }
    for (const line of plan.summary) {
      out(line);
    }
    out(`owner ${AccountAddress.toBase58(owner.address)}`);

    let energy = 0n;
    if (plan.kind === "update") {
      const dryRun = await client.invokeContract({
        invoker: owner.address,
        contract: plan.vault,
        method: ReceiveName.fromString(`${CONTRACT_NAME}.${plan.entrypoint}`),
        parameter: Parameter.fromBuffer(new Uint8Array(plan.parameter).buffer),
        amount: CcdAmount.fromMicroCcd(plan.amount),
        energy: Energy.create(plan.energy ?? DRY_RUN_ENERGY),
      });
      if (dryRun.tag !== "success") {
        const reason = dryRun.reason;
        const code = reason !== null && "rejectReason" in reason && typeof reason.rejectReason === "number" ? reason.rejectReason : null;
        err(`dry run rejected: ${describeRejectCode(code)}${send ? "; nothing was sent" : ""}`);
        return 1;
      }
      energy = plan.energy ?? energyFor(dryRun.usedEnergy.value);
      out(`dry run ok: used ${String(dryRun.usedEnergy.value)} energy; would send with ${String(energy)}`);
    } else if (plan.kind === "init") {
      energy = plan.energy;
      out(`energy ${String(energy)} (an init cannot be dry-run)`);
    }

    if (!send) {
      out("dry run only: nothing was sent. Add --send to submit.");
      return 0;
    }

    const sendable: SendablePlan = plan;
    const signed = await signPlan(owner, sendable, {
      nonce: await nextNonce(client, owner.address),
      energy,
      nowMs: (deps.now ?? Date.now)(),
    });
    const outcome = await submit(client, signed, FINALIZATION_TIMEOUT_MS);
    out(`transaction ${outcome.transaction}`);
    if (!outcome.ok) {
      err(`${outcome.reason}${outcome.rejectCode === null ? "" : ` (${describeRejectCode(outcome.rejectCode)})`}`);
      return 1;
    }
    if (plan.kind === "deploy") {
      if (outcome.moduleRef !== plan.moduleRef) {
        err(`the chain reports module ${String(outcome.moduleRef)}, not the expected ${plan.moduleRef}`);
        return 1;
      }
      out(`deployed module ${plan.moduleRef}`);
    } else if (plan.kind === "init") {
      if (outcome.contract === undefined) {
        err("the init outcome has no contract address");
        return 1;
      }
      out(`vault created at <${String(outcome.contract.index)},${String(outcome.contract.subindex)}>`);
    } else {
      out("finalized: ok");
    }
    return 0;
  } catch (error) {
    if (error instanceof UsageError) {
      err(error.message);
      return 2;
    }
    err(message(error));
    return 2;
  }
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
    loadOwner: (env) => loadKeyFile(env, OWNER_KEY_VAR),
    connect: (env) => connectTestnetNode(env),
    readFile: (path) => new Uint8Array(readFileSync(path)),
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
