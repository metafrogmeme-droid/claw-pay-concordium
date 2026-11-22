/**
 * Loading the agent key on the operator box.
 *
 * `CLAW_PAY_AGENT_KEY_FILE` names a Concordium wallet export (JSON). The file
 * must be a regular file owned by the current user with no group or other
 * permissions (mode 600), checked before it is read. The export must be for
 * `testnet`. Error messages never include the file's contents.
 *
 * Development and CI environments hold no keys: this runs only where the
 * operator has put a throwaway testnet key.
 */

import * as nodeFs from "node:fs";

import { AccountAddress, buildAccountSigner, parseWallet, type AccountSigner } from "@concordium/web-sdk";

export const KEY_FILE_VAR = "CLAW_PAY_AGENT_KEY_FILE";

/** The parts of `node:fs` the loader uses, so tests can inject a fake. */
export interface KeyFs {
  statSync(path: string): { isFile(): boolean; mode: number; uid: number };
  readFileSync(path: string, encoding: "utf8"): string;
}

export interface AgentKey {
  address: AccountAddress.Type;
  signer: AccountSigner;
}

/** Thrown when the key file is missing, exposed or not a testnet wallet export. */
export class KeyFileError extends Error {
  override name = "KeyFileError";
}

export interface LoadKeyOptions {
  fs?: KeyFs;
  /** The current user's uid. Defaults to `process.getuid()`. */
  uid?: number;
}

export function loadAgentKey(env: Readonly<Record<string, string | undefined>>, options: LoadKeyOptions = {}): AgentKey {
  const fs = options.fs ?? nodeFs;
  const path = env[KEY_FILE_VAR];
  if (path === undefined || path === "") {
    throw new KeyFileError(`${KEY_FILE_VAR} is not set`);
  }
  let stats: ReturnType<KeyFs["statSync"]>;
  try {
    stats = fs.statSync(path);
  } catch {
    throw new KeyFileError(`${KEY_FILE_VAR} does not name a readable file`);
  }
  if (!stats.isFile()) {
    throw new KeyFileError(`${KEY_FILE_VAR} does not name a regular file`);
  }
  const permissions = stats.mode & 0o777;
  if ((permissions & 0o077) !== 0) {
    throw new KeyFileError(
      `the key file has mode ${permissions.toString(8).padStart(3, "0")}; it must be 600 (no group or other access)`,
    );
  }
  const uid = options.uid ?? process.getuid?.();
  if (uid !== undefined && stats.uid !== uid) {
    throw new KeyFileError("the key file must be owned by the user running the client");
  }
  let text: string;
  try {
    text = fs.readFileSync(path, "utf8");
  } catch {
    throw new KeyFileError("the key file could not be read");
  }
  let wallet: ReturnType<typeof parseWallet>;
  try {
    wallet = parseWallet(text);
  } catch {
    // The parser's message can quote the input; never pass it on.
    throw new KeyFileError("the key file is not a Concordium wallet export");
  }
  if (wallet.environment !== "testnet") {
    throw new KeyFileError("the key file is not a testnet wallet export; Claw Pay for Concordium runs on testnet only");
  }
  let address: AccountAddress.Type;
  let signer: AccountSigner;
  try {
    address = AccountAddress.fromBase58(wallet.value.address);
    signer = buildAccountSigner(wallet);
  } catch {
    throw new KeyFileError("the key file is not a Concordium wallet export");
  }
  return { address, signer };
}
