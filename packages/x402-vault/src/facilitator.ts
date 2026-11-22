/**
 * Facilitator side of `vault-exact`: verify an agent's sponsored
 * `guard_vault.pay` transaction against the payment requirements, then
 * co-sign as sponsor, submit, and confirm the vault's receipt.
 *
 * Every rule in `docs/x402-vault-scheme.md` maps to one `invalidReason`.
 * Decision 8 (fee griefing) is enforced here: only configured vaults, an
 * energy cap, expiry at most 60 s ahead, a dry run before co-signing, and
 * one in-flight payment per sender.
 */

import {
  AccountAddress,
  AccountTransactionType,
  ContractAddress,
  Parameter,
  type AccountSigner,
} from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";
import { decodeEvent, equalBytes, toHex } from "@claw-pay-concordium/verifier";
import type {
  Network,
  PaymentPayload,
  PaymentRequirements,
  SchemeNetworkFacilitator,
  SettleResponse,
  VerifyResponse,
} from "@x402/core/types";

import type { VaultChain } from "./chain.ts";
import {
  MAX_TIMEOUT_SECONDS,
  PAY_ENTRYPOINT,
  RequirementsError,
  SCHEME,
  decodePayParams,
  invoiceHash,
  parseRequirements,
  type PayParams,
  type VaultExactRequirements,
} from "./scheme.ts";

export type InvalidReason =
  | "invalid_requirements"
  | "unsupported_network"
  | "sponsor_mismatch"
  | "invalid_transaction_format"
  | "invalid_transaction_version"
  | "not_a_contract_update"
  | "nonzero_amount"
  | "vault_not_allowed"
  | "wrong_entrypoint"
  | "energy_too_high"
  | "invalid_pay_params"
  | "provider_mismatch"
  | "amount_mismatch"
  | "invoice_mismatch"
  | "sender_is_sponsor"
  | "expired"
  | "expiry_too_far"
  | "invalid_sender_signature"
  | "sender_not_agent"
  | "dry_run_rejected"
  | "dry_run_receipt_mismatch"
  | "payment_in_flight";

export interface FacilitatorConfig {
  network: Network;
  /** The sponsor account and its signer. The signer is never stored elsewhere. */
  sponsor: { address: AccountAddress.Type; signer: AccountSigner };
  /** Vault instances this facilitator will sponsor `pay` calls for. */
  vaults: readonly ContractAddress.Type[];
  /** Maximum execution energy it will sponsor. */
  maxEnergy: bigint;
  /** Expiry cap in seconds; at most 60. */
  maxTimeoutSeconds?: number;
  chain: VaultChain;
  /** Current time in milliseconds. Defaults to `Date.now`. */
  now?: () => number;
  finalizationTimeoutMs?: number;
}

interface Checked {
  signable: Transaction.Signable;
  sender: AccountAddress.Type;
  vault: ContractAddress.Type;
  params: PayParams;
  offer: VaultExactRequirements;
}

class Invalid extends Error {
  readonly reason: InvalidReason;
  readonly payer: string | undefined;

  constructor(reason: InvalidReason, message: string, payer?: string) {
    super(message);
    this.reason = reason;
    this.payer = payer;
  }
}

export class VaultExactFacilitator implements SchemeNetworkFacilitator {
  readonly scheme = SCHEME;
  readonly caipFamily = "ccd:*";
  readonly #config: FacilitatorConfig;
  readonly #maxTimeoutSeconds: number;
  readonly #inFlight = new Set<string>();

  constructor(config: FacilitatorConfig) {
    const maxTimeout = config.maxTimeoutSeconds ?? MAX_TIMEOUT_SECONDS;
    if (maxTimeout < 1 || maxTimeout > MAX_TIMEOUT_SECONDS) {
      throw new RangeError(`maxTimeoutSeconds must be 1 to ${String(MAX_TIMEOUT_SECONDS)}`);
    }
    this.#config = config;
    this.#maxTimeoutSeconds = maxTimeout;
  }

  #sponsorBase58(): string {
    return AccountAddress.toBase58(this.#config.sponsor.address);
  }

  getExtra(network: Network): Record<string, unknown> | undefined {
    return network === this.#config.network ? { feePayer: this.#sponsorBase58() } : undefined;
  }

  getSigners(network: string): string[] {
    return network === this.#config.network ? [this.#sponsorBase58()] : [];
  }

  async verify(payload: PaymentPayload, requirements: PaymentRequirements): Promise<VerifyResponse> {
    try {
      const checked = await this.#check(payload, requirements);
      const payer = AccountAddress.toBase58(checked.sender);
      if (this.#inFlight.has(payer)) {
        return invalidResponse(
          new Invalid("payment_in_flight", "a payment from this sender is already in flight", payer),
        );
      }
      return { isValid: true, payer };
    } catch (error) {
      if (error instanceof Invalid) {
        return invalidResponse(error);
      }
      throw error;
    }
  }

  async settle(payload: PaymentPayload, requirements: PaymentRequirements): Promise<SettleResponse> {
    const network = this.#config.network;
    let checked: Checked;
    try {
      checked = await this.#check(payload, requirements);
    } catch (error) {
      if (error instanceof Invalid) {
        return failure(network, error.reason, error.message, error.payer);
      }
      throw error;
    }
    const payer = AccountAddress.toBase58(checked.sender);
    if (this.#inFlight.has(payer)) {
      return failure(network, "payment_in_flight", "a payment from this sender is already in flight", payer);
    }

    this.#inFlight.add(payer);
    try {
      if (checked.signable.version !== 1) {
        return failure(network, "invalid_transaction_version", "not a V1 transaction", payer);
      }
      const sponsored = await Transaction.sponsor(checked.signable, this.#config.sponsor.signer);
      const transaction = await this.#config.chain.submit(Transaction.finalize(sponsored));
      const result = await this.#config.chain.waitForFinalization(
        transaction,
        this.#config.finalizationTimeoutMs ?? 60_000,
      );
      if (result.status === "timeout") {
        return failure(network, "finalization_timeout", "not finalized in time", payer, transaction);
      }
      if (!result.success) {
        return failure(network, "transaction_rejected", result.message, payer, transaction);
      }
      const mismatch = receiptMismatch(result.events, checked);
      if (mismatch !== null) {
        return failure(network, "receipt_mismatch", mismatch, payer, transaction);
      }
      return {
        success: true,
        payer,
        transaction,
        network,
        amount: String(checked.params.amount),
      };
    } finally {
      this.#inFlight.delete(payer);
    }
  }

  async #check(payload: PaymentPayload, requirements: PaymentRequirements): Promise<Checked> {
    const config = this.#config;

    // The offer itself.
    let offer: VaultExactRequirements;
    try {
      offer = parseRequirements(requirements);
    } catch (error) {
      if (error instanceof RequirementsError) {
        throw new Invalid("invalid_requirements", error.message);
      }
      throw error;
    }
    if (offer.network !== config.network) {
      throw new Invalid("unsupported_network", `this facilitator serves ${config.network}`);
    }
    const sponsor = config.sponsor.address;
    if (!AccountAddress.equals(AccountAddress.fromBase58(offer.feePayer), sponsor)) {
      throw new Invalid("sponsor_mismatch", "extra.feePayer is not this facilitator's sponsor");
    }

    // Rule 1: a V1 transaction that parses.
    let signable: Transaction.Signable;
    try {
      signable = Transaction.signableFromJSON(payload.payload["signedTransaction"]);
    } catch {
      throw new Invalid("invalid_transaction_format", "payload.signedTransaction does not parse");
    }
    if (signable.version !== 1) {
      throw new Invalid("invalid_transaction_version", "the transaction must be V1 (sponsored)");
    }
    const sender = signable.header.sender;
    const payer = AccountAddress.toBase58(sender);

    // Rule 2: an UpdateContract calling pay on a configured vault, no CCD, capped energy.
    const txPayload = signable.payload;
    if (txPayload.type !== AccountTransactionType.Update) {
      throw new Invalid("not_a_contract_update", "the transaction is not a contract update", payer);
    }
    if (txPayload.amount.microCcdAmount !== 0n) {
      throw new Invalid("nonzero_amount", "pay must not carry CCD", payer);
    }
    const vault = txPayload.address;
    if (!config.vaults.some((allowed) => ContractAddress.equals(allowed, vault))) {
      throw new Invalid("vault_not_allowed", "this facilitator does not sponsor that contract", payer);
    }
    if (txPayload.receiveName.toString() !== PAY_ENTRYPOINT) {
      throw new Invalid("wrong_entrypoint", `only ${PAY_ENTRYPOINT} is sponsored`, payer);
    }
    const energy = signable.header.executionEnergyAmount.value;
    if (energy > config.maxEnergy) {
      throw new Invalid("energy_too_high", "execution energy is above the sponsored cap", payer);
    }

    // Rules 3 and 4: the parameter is exactly PayParams for this offer.
    const message = Parameter.toBuffer(txPayload.message);
    let params: PayParams;
    try {
      params = decodePayParams(message);
    } catch {
      throw new Invalid("invalid_pay_params", "the parameter is not a 56-byte PayParams", payer);
    }
    if (params.provider !== offer.provider) {
      throw new Invalid("provider_mismatch", "provider differs from extra.provider", payer);
    }
    if (params.amount !== offer.amount) {
      throw new Invalid("amount_mismatch", "amount differs from the required amount", payer);
    }
    if (!equalBytes(params.invoiceHash, invoiceHash(offer))) {
      throw new Invalid("invoice_mismatch", "invoice hash does not match the offer", payer);
    }

    // Rule 5: sponsored by this facilitator, and not by the sender itself.
    const headerSponsor = signable.header.sponsor;
    if (headerSponsor === undefined || !AccountAddress.equals(headerSponsor.account, sponsor)) {
      throw new Invalid("sponsor_mismatch", "the transaction names a different sponsor", payer);
    }
    if (AccountAddress.equals(sender, sponsor)) {
      throw new Invalid("sender_is_sponsor", "the sponsor cannot be the sender", payer);
    }

    // Rule 6: expiry in the future and within the cap.
    const nowSeconds = BigInt(Math.floor((config.now ?? Date.now)() / 1000));
    const expiry = signable.header.expiry.expiryEpochSeconds;
    const cap = BigInt(Math.min(offer.maxTimeoutSeconds, this.#maxTimeoutSeconds));
    if (expiry <= nowSeconds) {
      throw new Invalid("expired", "the transaction has expired", payer);
    }
    if (expiry > nowSeconds + cap) {
      throw new Invalid("expiry_too_far", "the transaction expires too far in the future", payer);
    }

    // Rule 7: the sender's signature, against its on-chain credentials.
    const signatureValid = await config.chain
      .getAccountInfo(sender)
      .then((account) => Transaction.verifySignature(signable, signable.signatures.sender, account))
      .catch(() => false);
    if (!signatureValid) {
      throw new Invalid("invalid_sender_signature", "the sender signature does not verify", payer);
    }

    // Rule 8: the sender is the vault's agent.
    const agent = await config.chain.getVaultAgent(vault);
    if (!AccountAddress.equals(agent, sender)) {
      throw new Invalid("sender_not_agent", "the sender is not this vault's agent", payer);
    }

    // Rule 9: a dry run succeeds and logs the expected receipt.
    const dryRun = await config.chain.dryRunPay(vault, sender, message, energy);
    if (!dryRun.ok) {
      const code = dryRun.rejectCode === null ? "" : ` (reject code ${String(dryRun.rejectCode)})`;
      throw new Invalid("dry_run_rejected", `the vault would reject this payment${code}: ${dryRun.message}`, payer);
    }
    const checked: Checked = { signable, sender, vault, params, offer };
    const mismatch = receiptMismatch(dryRun.events, checked);
    if (mismatch !== null) {
      throw new Invalid("dry_run_receipt_mismatch", mismatch, payer);
    }
    return checked;
  }
}

/** Why the vault events don't show exactly the expected receipt, or null. */
function receiptMismatch(events: readonly Uint8Array[], checked: Checked): string | null {
  const receipts = [];
  for (const raw of events) {
    try {
      const event = decodeEvent(raw);
      if (event.kind === "Receipt") {
        receipts.push(event.body);
      }
    } catch {
      return "an event could not be decoded";
    }
  }
  const [receipt, ...rest] = receipts;
  if (receipt === undefined || rest.length > 0) {
    return `expected exactly one Receipt, found ${String(receipts.length)}`;
  }
  const payTo = AccountAddress.fromBase58(checked.offer.payTo);
  if (receipt.provider !== checked.params.provider) {
    return "receipt provider differs";
  }
  if (receipt.amount !== checked.params.amount) {
    return "receipt amount differs";
  }
  if (!equalBytes(receipt.invoiceHash, checked.params.invoiceHash)) {
    return "receipt invoice hash differs";
  }
  if (!equalBytes(receipt.payee, payTo.decodedAddress)) {
    return `receipt payee ${toHex(receipt.payee).slice(0, 12)}… is not payTo`;
  }
  return null;
}

function invalidResponse(error: Invalid): VerifyResponse {
  return {
    isValid: false,
    invalidReason: error.reason,
    invalidMessage: error.message,
    ...(error.payer === undefined ? {} : { payer: error.payer }),
  };
}

function failure(
  network: Network,
  errorReason: string,
  errorMessage: string,
  payer?: string,
  transaction = "",
): SettleResponse {
  return {
    success: false,
    errorReason,
    errorMessage,
    transaction,
    network,
    ...(payer === undefined ? {} : { payer }),
  };
}
