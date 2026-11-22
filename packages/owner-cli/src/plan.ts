/**
 * Turning `claw-pay-owner` arguments into a transaction plan: what would be
 * sent, with a human-readable summary. Pure, so every command is tested
 * without a node.
 */

import {
  AccountAddress,
  ContractAddress,
  ModuleReference,
  calculateModuleReference,
  versionedModuleSourceFromBuffer,
} from "@concordium/web-sdk";
import { formatCcd } from "@claw-pay-concordium/verifier";

import { encodeAccount, encodeBool, encodeCapsParams, encodeInitParams, encodeProviderParams, u64 } from "./params.ts";

export const CONTRACT_NAME = "guard_vault";
export const DEFAULT_INIT_ENERGY = 30_000n;

export type Plan =
  | { kind: "deploy"; source: Uint8Array; moduleRef: string; summary: string[] }
  | { kind: "init"; moduleRef: ModuleReference.Type; parameter: Uint8Array; energy: bigint; summary: string[] }
  | {
      kind: "update";
      vault: ContractAddress.Type;
      entrypoint: string;
      parameter: Uint8Array;
      /** Micro-CCD attached (deposit only). */
      amount: bigint;
      /** Set by --energy; otherwise taken from the dry run. */
      energy?: bigint;
      summary: string[];
    }
  | { kind: "view"; vault: ContractAddress.Type }
  | { kind: "provider"; vault: ContractAddress.Type; tokenId: bigint };

export interface Parsed {
  plan: Plan;
  send: boolean;
}

/** Thrown for a bad command line. */
export class UsageError extends Error {
  override name = "UsageError";
}

export const USAGE = [
  "usage: claw-pay-owner <command> [options] [--send]",
  "  deploy --module <module.wasm.v1>",
  "  init --module-ref <hex> --agent <account> --per-tx-cap <µCCD> --daily-cap <µCCD> --registry <index,subindex> [--energy <n>]",
  "  deposit --vault <index[,subindex]> --amount <µCCD>",
  "  withdraw --vault <v> --amount <µCCD>",
  "  set-caps --vault <v> --per-tx-cap <µCCD> --daily-cap <µCCD>",
  "  set-agent --vault <v> --agent <account>",
  "  pause --vault <v>   |   unpause --vault <v>",
  "  add-provider --vault <v> --token <id> --card-hash <hex>",
  "  remove-provider --vault <v> --token <id>",
  "  view --vault <v>   |   provider --vault <v> --token <id>",
  "State-changing commands are a dry run unless --send is given.",
].join("\n");

const DECIMAL = /^(0|[1-9][0-9]*)$/;
const HEX32 = /^[0-9a-f]{64}$/;
const U64_MAX = (1n << 64n) - 1n;

const COMMANDS: Record<string, { required: string[]; optional: string[] }> = {
  deploy: { required: ["--module"], optional: [] },
  init: { required: ["--module-ref", "--agent", "--per-tx-cap", "--daily-cap", "--registry"], optional: ["--energy"] },
  deposit: { required: ["--vault", "--amount"], optional: ["--energy"] },
  withdraw: { required: ["--vault", "--amount"], optional: ["--energy"] },
  "set-caps": { required: ["--vault", "--per-tx-cap", "--daily-cap"], optional: ["--energy"] },
  "set-agent": { required: ["--vault", "--agent"], optional: ["--energy"] },
  pause: { required: ["--vault"], optional: ["--energy"] },
  unpause: { required: ["--vault"], optional: ["--energy"] },
  "add-provider": { required: ["--vault", "--token", "--card-hash"], optional: ["--energy"] },
  "remove-provider": { required: ["--vault", "--token"], optional: ["--energy"] },
  view: { required: ["--vault"], optional: [] },
  provider: { required: ["--vault", "--token"], optional: [] },
};

function uint(value: string, what: string): bigint {
  if (!DECIMAL.test(value) || BigInt(value) > U64_MAX) {
    throw new UsageError(`${what} must be a whole number (u64)`);
  }
  return BigInt(value);
}

function positive(value: string, what: string): bigint {
  const parsed = uint(value, what);
  if (parsed === 0n) {
    throw new UsageError(`${what} must be greater than 0`);
  }
  return parsed;
}

function contract(value: string, what: string): ContractAddress.Type {
  const [index = "", subindex = "0", ...rest] = value.split(",");
  if (rest.length > 0) {
    throw new UsageError(`${what} must be <index> or <index>,<subindex>`);
  }
  return ContractAddress.create(uint(index, `${what} index`), uint(subindex, `${what} subindex`));
}

function account(value: string, what: string): AccountAddress.Type {
  try {
    return AccountAddress.fromBase58(value);
  } catch {
    throw new UsageError(`${what} is not a valid account address`);
  }
}

function hex32(value: string, what: string): Uint8Array {
  if (!HEX32.test(value)) {
    throw new UsageError(`${what} must be 64 lowercase hex digits`);
  }
  return new Uint8Array(Buffer.from(value, "hex"));
}

function at(vault: ContractAddress.Type): string {
  return `<${String(vault.index)},${String(vault.subindex)}>`;
}

/**
 * Parse a command line. `readFile` is only used by `deploy`, to read the
 * module.
 */
export function parseCommand(argv: readonly string[], readFile: (path: string) => Uint8Array): Parsed {
  const [command, ...rest] = argv;
  const spec = command === undefined ? undefined : COMMANDS[command];
  if (command === undefined || spec === undefined) {
    throw new UsageError(command === undefined ? "no command given" : `unknown command ${JSON.stringify(command)}`);
  }
  const flags = new Map<string, string>();
  let send = false;
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i] ?? "";
    if (flag === "--send") {
      if (send) {
        throw new UsageError("--send given twice");
      }
      send = true;
      continue;
    }
    const value = rest[i + 1];
    if (![...spec.required, ...spec.optional].includes(flag) || value === undefined || flags.has(flag)) {
      throw new UsageError(`unexpected argument ${JSON.stringify(flag)} for ${command}`);
    }
    flags.set(flag, value);
    i += 1;
  }
  for (const flag of spec.required) {
    if (!flags.has(flag)) {
      throw new UsageError(`${command} needs ${flag}`);
    }
  }
  const get = (flag: string): string => flags.get(flag) ?? "";
  const energyFlag = flags.get("--energy");
  const energy = energyFlag === undefined ? undefined : positive(energyFlag, "--energy");
  if ((command === "view" || command === "provider") && send) {
    throw new UsageError(`${command} only reads; --send does not apply`);
  }

  const update = (vault: ContractAddress.Type, entrypoint: string, parameter: Uint8Array, amount: bigint, summary: string[]): Parsed => {
    const plan: Plan = { kind: "update", vault, entrypoint, parameter, amount, summary };
    if (energy !== undefined) {
      plan.energy = energy;
    }
    return { plan, send };
  };

  switch (command) {
    case "deploy": {
      const source = readFile(get("--module"));
      let moduleRef: string;
      try {
        const copy = new Uint8Array(source.length);
        copy.set(source);
        moduleRef = ModuleReference.toHexString(calculateModuleReference(versionedModuleSourceFromBuffer(copy.buffer)));
      } catch {
        throw new UsageError("--module is not a versioned Concordium module (module.wasm.v1)");
      }
      return {
        plan: { kind: "deploy", source, moduleRef, summary: [`deploy module ${moduleRef} (${String(source.length)} bytes)`] },
        send,
      };
    }
    case "init": {
      const perTxCap = positive(get("--per-tx-cap"), "--per-tx-cap");
      const dailyCap = positive(get("--daily-cap"), "--daily-cap");
      if (perTxCap > dailyCap) {
        throw new UsageError("--per-tx-cap must be at most --daily-cap");
      }
      const agent = account(get("--agent"), "--agent");
      const registry = contract(get("--registry"), "--registry");
      const moduleRef = ModuleReference.fromBuffer(hex32(get("--module-ref"), "--module-ref").buffer as ArrayBuffer);
      return {
        plan: {
          kind: "init",
          moduleRef,
          parameter: encodeInitParams({ agent, perTxCap, dailyCap, registry }),
          energy: energy ?? DEFAULT_INIT_ENERGY,
          summary: [
            `init ${CONTRACT_NAME} from module ${get("--module-ref")}`,
            `  agent ${AccountAddress.toBase58(agent)}`,
            `  per-tx cap ${formatCcd(perTxCap)}, daily cap ${formatCcd(dailyCap)}`,
            `  registry ${at(registry)} (must be the official CIS-8004 registry on testnet)`,
          ],
        },
        send,
      };
    }
    case "deposit": {
      const vault = contract(get("--vault"), "--vault");
      const amount = positive(get("--amount"), "--amount");
      return update(vault, "deposit", new Uint8Array(), amount, [`deposit ${formatCcd(amount)} into ${at(vault)}`]);
    }
    case "withdraw": {
      const vault = contract(get("--vault"), "--vault");
      const amount = positive(get("--amount"), "--amount");
      return update(vault, "withdraw", u64(amount), 0n, [`withdraw ${formatCcd(amount)} from ${at(vault)} to the owner`]);
    }
    case "set-caps": {
      const vault = contract(get("--vault"), "--vault");
      const perTxCap = positive(get("--per-tx-cap"), "--per-tx-cap");
      const dailyCap = positive(get("--daily-cap"), "--daily-cap");
      if (perTxCap > dailyCap) {
        throw new UsageError("--per-tx-cap must be at most --daily-cap");
      }
      return update(vault, "set_caps", encodeCapsParams({ perTxCap, dailyCap }), 0n, [
        `set caps on ${at(vault)}: per-tx ${formatCcd(perTxCap)}, daily ${formatCcd(dailyCap)}`,
      ]);
    }
    case "set-agent": {
      const vault = contract(get("--vault"), "--vault");
      const agent = account(get("--agent"), "--agent");
      return update(vault, "set_agent", encodeAccount(agent), 0n, [`set the agent of ${at(vault)} to ${AccountAddress.toBase58(agent)}`]);
    }
    case "pause":
    case "unpause": {
      const vault = contract(get("--vault"), "--vault");
      const paused = command === "pause";
      return update(vault, "set_paused", encodeBool(paused), 0n, [`${paused ? "pause" : "unpause"} ${at(vault)}`]);
    }
    case "add-provider": {
      const vault = contract(get("--vault"), "--vault");
      const tokenId = uint(get("--token"), "--token");
      const cardHash = hex32(get("--card-hash"), "--card-hash");
      return update(vault, "add_provider", encodeProviderParams({ tokenId, cardHash }), 0n, [
        `allowlist registry agent ${String(tokenId)} on ${at(vault)} with card hash ${get("--card-hash")}`,
      ]);
    }
    case "remove-provider": {
      const vault = contract(get("--vault"), "--vault");
      const tokenId = uint(get("--token"), "--token");
      return update(vault, "remove_provider", u64(tokenId), 0n, [`remove registry agent ${String(tokenId)} from ${at(vault)}`]);
    }
    case "view":
      return { plan: { kind: "view", vault: contract(get("--vault"), "--vault") }, send };
    case "provider":
      return { plan: { kind: "provider", vault: contract(get("--vault"), "--vault"), tokenId: uint(get("--token"), "--token") }, send };
    default:
      throw new UsageError(`unknown command ${JSON.stringify(command)}`);
  }
}
