/**
 * Decoding of a CIS-8004 `agentOf` reply (`AgentView`), written from
 * `source/CIS/cis-8004.rst` and `cis-8.rst` in
 * `Concordium/concordium-update-proposals`, independently of the vault's
 * Rust parser.
 *
 *   AgentView ::= token_id owner_account agent_uri? metadata_hash?
 *                 external_reference? agent_wallet? status registered_at
 *                 revoked_at? revocation_reason?
 *
 * Integers are little-endian. Strings and byte strings carry a 4-byte length.
 * Optional fields carry a 1-byte tag (0 absent, 1 present).
 */

import { ByteReader, DecodeError } from "@claw-pay-concordium/verifier";

export type AgentStatus = "Active" | "Revoked";

export interface ExternalReference {
  /** The CIS-8 external key registry instance. */
  contract: { index: bigint; subindex: bigint };
  namespace: string;
  keyType: string;
  publicKey: Uint8Array;
}

export interface AgentView {
  tokenId: bigint;
  owner: Uint8Array;
  agentUri: string | null;
  /** SHA-256 of the Agent Card bytes at `agentUri`. */
  metadataHash: Uint8Array | null;
  externalReference: ExternalReference | null;
  /** The agent's payment address. */
  agentWallet: Uint8Array | null;
  status: AgentStatus;
  registeredAt: bigint;
  revokedAt: bigint | null;
  revocationReason: string | null;
}

const UTF8 = new TextDecoder("utf-8", { fatal: true });

function bytestring(reader: ByteReader): Uint8Array {
  return reader.bytes(reader.u32());
}

function string(reader: ByteReader): string {
  const bytes = bytestring(reader);
  try {
    return UTF8.decode(bytes);
  } catch {
    throw new DecodeError("string is not valid UTF-8");
  }
}

function optional<T>(reader: ByteReader, read: (reader: ByteReader) => T): T | null {
  const tag = reader.u8();
  if (tag === 0) {
    return null;
  }
  if (tag === 1) {
    return read(reader);
  }
  throw new DecodeError(`invalid option tag ${String(tag)}`);
}

function tokenId(reader: ByteReader): bigint {
  const length = reader.u8();
  if (length !== 8) {
    throw new DecodeError(`AgentTokenId must have length 8, found ${String(length)}`);
  }
  return reader.u64();
}

function externalReference(reader: ByteReader): ExternalReference {
  const contract = { index: reader.u64(), subindex: reader.u64() };
  const kind = reader.u8();
  if (kind !== 0) {
    throw new DecodeError(`unknown external reference kind ${String(kind)}`);
  }
  return {
    contract,
    namespace: string(reader),
    keyType: string(reader),
    publicKey: bytestring(reader),
  };
}

function status(reader: ByteReader): AgentStatus {
  const value = reader.u8();
  if (value === 0) {
    return "Active";
  }
  if (value === 1) {
    return "Revoked";
  }
  throw new DecodeError(`unknown agent status ${String(value)}`);
}

/** Decode an `agentOf` reply. Throws `DecodeError` on any layout mismatch. */
export function decodeAgentView(bytes: Uint8Array): AgentView {
  const reader = new ByteReader(bytes);
  const view: AgentView = {
    tokenId: tokenId(reader),
    owner: reader.bytes(32),
    agentUri: optional(reader, string),
    metadataHash: optional(reader, (r) => r.bytes(32)),
    externalReference: optional(reader, externalReference),
    agentWallet: optional(reader, (r) => r.bytes(32)),
    status: status(reader),
    registeredAt: reader.u64(),
    revokedAt: optional(reader, (r) => r.u64()),
    revocationReason: optional(reader, string),
  };
  reader.finish();
  return view;
}
