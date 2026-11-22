/**
 * `claw-pay-seller`: the demo x402 seller with an in-process `vault-exact`
 * facilitator. Runs on the operator box, on loopback.
 *
 * | Variable | Meaning |
 * |---|---|
 * | `CLAW_PAY_NETWORK` | Must be exactly `testnet`. Checked first. |
 * | `CLAW_PAY_SELLER_CONFIG` | The seller config (JSON; see seller-config.ts). |
 * | `CLAW_PAY_SPONSOR_KEY_FILE` | The sponsor's testnet wallet export (mode 600). The sponsor pays transaction fees. |
 * | `CLAW_PAY_NODE` | `host:port` of a Concordium testnet gRPC endpoint. |
 */

import { readFileSync, realpathSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";

import { AccountAddress, type AccountSigner } from "@concordium/web-sdk";
import { assertTestnet, loadKeyFile } from "@claw-pay-concordium/agent-client";
import { connectTestnetNode, nodeVaultChain, type NodeClient } from "@claw-pay-concordium/node-adapter";
import { CONCORDIUM_TESTNET, VaultExactFacilitator } from "@claw-pay-concordium/x402-vault";
import { formatCcd } from "@claw-pay-concordium/verifier";
import type { SettleResponse } from "@x402/core/types";

import { InvoiceBook } from "./invoice-book.ts";
import { SellerConfigError, parseSellerConfig } from "./seller-config.ts";
import { createSeller } from "./seller.ts";

export const SELLER_CONFIG_VAR = "CLAW_PAY_SELLER_CONFIG";
export const SPONSOR_KEY_VAR = "CLAW_PAY_SPONSOR_KEY_FILE";

export interface SellerDeps {
  env: Readonly<Record<string, string | undefined>>;
  readConfig: (path: string) => string;
  loadSponsor: (env: Readonly<Record<string, string | undefined>>) => { address: AccountAddress.Type; signer: AccountSigner };
  connect: (env: Readonly<Record<string, string | undefined>>) => Promise<NodeClient>;
  out: (line: string) => void;
  onSettle?: (result: SettleResponse) => void;
  now?: () => number;
}

export interface RunningSeller {
  url: string;
  /** The fee payer advertised in every offer (Base58). */
  sponsor: string;
  close: () => Promise<void>;
}

/** Start the seller. Throws, before listening, on any config, key or node problem. */
export async function startSeller(deps: SellerDeps): Promise<RunningSeller> {
  const { env } = deps;
  assertTestnet(env["CLAW_PAY_NETWORK"]);
  const configPath = env[SELLER_CONFIG_VAR];
  if (configPath === undefined || configPath === "") {
    throw new SellerConfigError(`${SELLER_CONFIG_VAR} is not set`);
  }
  let configJson: unknown;
  try {
    configJson = JSON.parse(deps.readConfig(configPath));
  } catch {
    throw new SellerConfigError(`${SELLER_CONFIG_VAR} could not be read as JSON`);
  }
  const config = parseSellerConfig(configJson);
  const sponsor = deps.loadSponsor(env);
  const client = await deps.connect(env);

  const timing = deps.now === undefined ? {} : { now: deps.now };
  const facilitator = new VaultExactFacilitator({
    network: CONCORDIUM_TESTNET,
    sponsor,
    vaults: config.vaults,
    maxEnergy: config.maxEnergy,
    chain: nodeVaultChain(client),
    ...timing,
  });
  const sponsorBase58 = AccountAddress.toBase58(sponsor.address);
  const book = new InvoiceBook({
    offer: { network: CONCORDIUM_TESTNET, payTo: config.payTo, feePayer: sponsorBase58, provider: config.provider },
    ...timing,
  });

  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(config.listen.port, config.listen.host, () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address() as AddressInfo;
  const host = address.family === "IPv6" ? `[${address.address}]` : address.address;
  const url = `http://${host}:${String(address.port)}`;
  server.on("request", createSeller({ routes: config.routes, book, facilitator, origin: url, ...(deps.onSettle === undefined ? {} : { onSettle: deps.onSettle }) }));

  deps.out(`claw-pay-seller listening on ${url} (testnet, loopback only)`);
  deps.out(`fee payer (sponsor) ${sponsorBase58}; paid to ${config.payTo} as registry agent ${String(config.provider)}`);
  for (const route of config.routes) {
    deps.out(`  ${url}${route.path}  ${formatCcd(route.price)}`);
  }
  return {
    url,
    sponsor: sponsorBase58,
    close: () =>
      new Promise((resolve, reject) => {
        server.close((error) => {
          if (error === undefined) {
            resolve();
          } else {
            reject(error);
          }
        });
      }),
  };
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
  startSeller({
    env: process.env,
    readConfig: (path) => readFileSync(path, "utf8"),
    loadSponsor: (env) => loadKeyFile(env, SPONSOR_KEY_VAR),
    connect: (env) => connectTestnetNode(env),
    out: (line) => {
      console.log(line);
    },
    onSettle: (result) => {
      console.log(result.success ? `settled ${result.transaction}` : `settlement failed: ${String(result.errorReason)}`);
    },
  }).then(
    (seller) => {
      process.once("SIGINT", () => {
        void seller.close();
      });
    },
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 2;
    },
  );
}
