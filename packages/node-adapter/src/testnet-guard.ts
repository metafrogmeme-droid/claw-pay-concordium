/**
 * The testnet guard and the narrow node-client type, with no Node-only
 * imports, so they work in a browser too (see browser.ts).
 *
 * `NodeClient` is the part of the SDK's gRPC client this package uses. The
 * Node client (`ConcordiumGRPCNodeClient`) and the browser client
 * (`ConcordiumGRPCWebClient`) both provide it.
 */

import { BlockHash, type ConcordiumGRPCClient } from "@concordium/web-sdk";

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

/** Thrown when the node is not on Concordium testnet. */
export class WrongNetworkError extends Error {
  override name = "WrongNetworkError";
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
