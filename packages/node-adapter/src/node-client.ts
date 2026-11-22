/**
 * Connecting to a Concordium node from Node.js (the operator box).
 *
 * `connectTestnetNode` makes the real gRPC client and refuses any node whose
 * genesis block is not Concordium testnet's, before anything else is asked
 * of it. The guard and the `NodeClient` type live in testnet-guard.ts, which
 * has no Node-only imports.
 */

import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";

import { assertTestnetNode, type NodeClient } from "./testnet-guard.ts";

export { TESTNET_GENESIS_PREFIX, WrongNetworkError, assertTestnetNode } from "./testnet-guard.ts";
export type { NodeClient } from "./testnet-guard.ts";

export const NODE_VAR = "CLAW_PAY_NODE";

/** Thrown when `CLAW_PAY_NODE` is missing or malformed. */
export class NodeAddressError extends Error {
  override name = "NodeAddressError";
}

/** Parse `host:port`. IPv6 literals are not supported. */
export function parseNodeAddress(value: string | undefined): { host: string; port: number } {
  if (value === undefined || value === "") {
    throw new NodeAddressError(`${NODE_VAR} is not set (host:port of a Concordium testnet gRPC endpoint)`);
  }
  const match = /^([A-Za-z0-9.-]+):([0-9]{1,5})$/.exec(value);
  const port = Number(match?.[2]);
  if (match?.[1] === undefined || !Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new NodeAddressError(`${NODE_VAR} must be host:port, for example node.example:20000`);
  }
  return { host: match[1], port };
}

export type CreateClient = (host: string, port: number) => NodeClient;

const createTlsClient: CreateClient = (host, port) => new ConcordiumGRPCNodeClient(host, port, credentials.createSsl());

/**
 * Connect to the node named by `CLAW_PAY_NODE` over TLS and check it is on
 * testnet. Run on the operator box only.
 */
export async function connectTestnetNode(
  env: Readonly<Record<string, string | undefined>>,
  create: CreateClient = createTlsClient,
): Promise<NodeClient> {
  const { host, port } = parseNodeAddress(env[NODE_VAR]);
  const client = create(host, port);
  await assertTestnetNode(client);
  return client;
}
