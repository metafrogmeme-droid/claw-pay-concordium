/**
 * The Concordium node this package talks to, and the testnet guard.
 *
 * `NodeClient` is the narrow part of the SDK's gRPC client this package uses,
 * so tests can inject a fake. `connectTestnetNode` makes the real client (on
 * the operator box only) and refuses any node whose genesis block is not
 * Concordium testnet's, before anything else is asked of it.
 */

import { BlockHash, type ConcordiumGRPCClient } from "@concordium/web-sdk";
import { ConcordiumGRPCNodeClient, credentials } from "@concordium/web-sdk/nodejs";

export type NodeClient = Pick<
  ConcordiumGRPCClient,
  | "getAccountInfo"
  | "getNextAccountNonce"
  | "invokeContract"
  | "sendTransaction"
  | "waitForTransactionFinalization"
  | "getConsensusStatus"
  | "getBlocksAtHeight"
  | "getBlockTransactionEvents"
>;

/**
 * Concordium testnet's genesis block hash starts with this: the reference
 * in the CAIP-2 network id `ccd:4221332d34e1694168c2a0c0b3fd0f27`.
 */
export const TESTNET_GENESIS_PREFIX = "4221332d34e1694168c2a0c0b3fd0f27";

export const NODE_VAR = "CLAW_PAY_NODE";

/** Thrown when the node is not on Concordium testnet. */
export class WrongNetworkError extends Error {
  override name = "WrongNetworkError";
}

/** Thrown when `CLAW_PAY_NODE` is missing or malformed. */
export class NodeAddressError extends Error {
  override name = "NodeAddressError";
}

/** Refuse unless the node's genesis block is Concordium testnet's. */
export async function assertTestnetNode(client: Pick<NodeClient, "getConsensusStatus">): Promise<void> {
  const status = await client.getConsensusStatus();
  const genesis = BlockHash.toHexString(status.genesisBlock);
  if (!genesis.startsWith(TESTNET_GENESIS_PREFIX)) {
    throw new WrongNetworkError(
      `the node's genesis block ${genesis} is not Concordium testnet's; Claw Pay for Concordium runs on testnet only`,
    );
  }
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
