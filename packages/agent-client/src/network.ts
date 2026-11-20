/**
 * Network guard.
 *
 * Claw Pay for Concordium runs on Concordium testnet only. The client checks
 * its configured network with `assertTestnet` before it does anything else,
 * so a mainnet, mistyped or missing setting fails closed.
 */

/** The only network this project may talk to. */
export const ALLOWED_NETWORK = "testnet";

export type AllowedNetwork = typeof ALLOWED_NETWORK;

/**
 * Throw unless `network` is exactly `"testnet"`.
 *
 * Takes `unknown` so values read straight from the environment (which may be
 * `undefined`) are rejected rather than coerced. No trimming, no case folding.
 */
export function assertTestnet(network: unknown): asserts network is AllowedNetwork {
  if (network !== ALLOWED_NETWORK) {
    const shown = typeof network === "string" ? JSON.stringify(network) : typeof network;
    throw new Error(
      `Network ${shown} is not allowed: Claw Pay for Concordium runs on Concordium testnet only.`,
    );
  }
}
