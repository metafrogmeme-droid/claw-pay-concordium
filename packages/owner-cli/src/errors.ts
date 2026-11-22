/**
 * The vault's reject codes. `guard_vault::Error` is append-only: variant i
 * (from 0) rejects with code -(i + 1). Checked against
 * `fixtures/owner-params.v1.json`, which the contract tests write.
 */

export const VAULT_ERRORS: readonly string[] = [
  "ParseParams",
  "NotOwner",
  "NotAgent",
  "AgentIsOwner",
  "InvalidCaps",
  "Paused",
  "InvalidNonce",
  "InvoiceAlreadyPaid",
  "ZeroAmount",
  "ExceedsPerTxCap",
  "ExceedsDailyCap",
  "InsufficientFunds",
  "Overflow",
  "TransferFailed",
  "ProviderNotAllowed",
  "ProviderNotActive",
  "CardHashMismatch",
  "NoAgentWallet",
  "RegistryQueryFailed",
  "LogFailed",
];

/** `-2 NotOwner`, or the bare code if it is not one of the vault's. */
export function describeRejectCode(code: number | null): string {
  if (code === null) {
    return "no reject code";
  }
  const name = code < 0 ? VAULT_ERRORS[-code - 1] : undefined;
  return name === undefined ? String(code) : `${String(code)} ${name}`;
}
