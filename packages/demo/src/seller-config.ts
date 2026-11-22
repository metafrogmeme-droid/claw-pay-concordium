/**
 * The demo seller's config file (`CLAW_PAY_SELLER_CONFIG`), strict JSON.
 * Numbers that can exceed JavaScript's safe range are decimal strings.
 *
 * ```json
 * {
 *   "listen": { "host": "127.0.0.1", "port": 8402 },
 *   "provider": "10",
 *   "payTo": "<the seller's registry agent_wallet, Base58>",
 *   "vaults": ["7,0"],
 *   "maxEnergy": "50000",
 *   "routes": [{ "path": "/weather", "price": "1000000", "contentType": "application/json", "body": "{\"forecast\":\"sunny\"}" }]
 * }
 * ```
 *
 * The demo seller listens on loopback only.
 */

import { AccountAddress, ContractAddress } from "@concordium/web-sdk";

export interface SellerRoute {
  path: string;
  /** Micro-CCD. */
  price: bigint;
  contentType: string;
  body: string;
}

export interface SellerConfig {
  listen: { host: string; port: number };
  /** The seller's registry token id. */
  provider: bigint;
  /** The seller's registry `agent_wallet`, Base58. */
  payTo: string;
  /** Vaults the in-process facilitator sponsors `pay` calls for. */
  vaults: ContractAddress.Type[];
  maxEnergy: bigint;
  routes: SellerRoute[];
}

export class SellerConfigError extends Error {
  override name = "SellerConfigError";
}

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1"]);
const DECIMAL = /^(0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;
const MAX_BODY = 64 * 1024;

function record(value: unknown, what: string): Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new SellerConfigError(`${what} must be an object`);
  }
  return value as Record<string, unknown>;
}

function u64(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > U64_MAX) {
    throw new SellerConfigError(`${what} must be a decimal string (u64)`);
  }
  return BigInt(value);
}

function positive(value: unknown, what: string): bigint {
  const parsed = u64(value, what);
  if (parsed === 0n) {
    throw new SellerConfigError(`${what} must be greater than 0`);
  }
  return parsed;
}

export function parseSellerConfig(json: unknown): SellerConfig {
  const raw = record(json, "the seller config");
  const listenRaw = raw["listen"] === undefined ? {} : record(raw["listen"], "listen");
  const host = listenRaw["host"] ?? "127.0.0.1";
  const port = listenRaw["port"] ?? 8402;
  if (typeof host !== "string" || !LOOPBACK.has(host)) {
    throw new SellerConfigError("listen.host must be loopback (127.0.0.1, localhost or ::1): the demo seller is not public");
  }
  if (typeof port !== "number" || !Number.isInteger(port) || port < 0 || port > 65_535) {
    throw new SellerConfigError("listen.port must be 0 to 65535");
  }
  const payTo = raw["payTo"];
  if (typeof payTo !== "string") {
    throw new SellerConfigError("payTo must be a Base58 account address");
  }
  try {
    AccountAddress.fromBase58(payTo);
  } catch {
    throw new SellerConfigError("payTo is not a valid account address");
  }
  const vaultsRaw = raw["vaults"];
  if (!Array.isArray(vaultsRaw) || vaultsRaw.length === 0) {
    throw new SellerConfigError("vaults must be a non-empty array of \"index,subindex\" strings");
  }
  const vaults = vaultsRaw.map((entry: unknown, i) => {
    const [index, subindex = "0", ...rest] = typeof entry === "string" ? entry.split(",") : [];
    if (index === undefined || rest.length > 0) {
      throw new SellerConfigError(`vaults[${String(i)}] must be "index" or "index,subindex"`);
    }
    return ContractAddress.create(u64(index, `vaults[${String(i)}] index`), u64(subindex, `vaults[${String(i)}] subindex`));
  });
  const routesRaw = raw["routes"];
  if (!Array.isArray(routesRaw) || routesRaw.length === 0) {
    throw new SellerConfigError("routes must be a non-empty array");
  }
  const routes = routesRaw.map((entry: unknown, i): SellerRoute => {
    const route = record(entry, `routes[${String(i)}]`);
    const path = route["path"];
    if (typeof path !== "string" || !/^\/[A-Za-z0-9._~/-]*$/.test(path) || path === "/health") {
      throw new SellerConfigError(`routes[${String(i)}].path must be a plain path like /weather (not /health)`);
    }
    const contentType = route["contentType"];
    if (typeof contentType !== "string" || contentType === "" || contentType.length > 100) {
      throw new SellerConfigError(`routes[${String(i)}].contentType must be a short non-empty string`);
    }
    const body = route["body"];
    if (typeof body !== "string" || Buffer.byteLength(body) > MAX_BODY) {
      throw new SellerConfigError(`routes[${String(i)}].body must be a string of at most 64 KiB`);
    }
    return { path, price: positive(route["price"], `routes[${String(i)}].price`), contentType, body };
  });
  if (new Set(routes.map((route) => route.path)).size !== routes.length) {
    throw new SellerConfigError("each route path may appear only once");
  }
  return {
    listen: { host, port },
    provider: u64(raw["provider"], "provider"),
    payTo,
    vaults,
    maxEnergy: positive(raw["maxEnergy"], "maxEnergy"),
    routes,
  };
}
