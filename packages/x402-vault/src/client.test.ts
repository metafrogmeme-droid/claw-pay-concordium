import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { AccountAddress, AccountTransactionType, ContractAddress, Parameter } from "@concordium/web-sdk";
import { Transaction } from "@concordium/web-sdk/transactions";

import { VaultExactClient, createVaultPayment, signWith, type AgentContext } from "./client.ts";
import { CONCORDIUM_TESTNET, decodePayParams, invoiceHash, newRequirements, parseRequirements } from "./scheme.ts";
import { addressOf, ephemeralAccount } from "./test-support.ts";

const NOW_MS = 1_795_350_000_000;
const VAULT = ContractAddress.create(7, 0);
const agentKey = ephemeralAccount(0x02);
const SPONSOR = addressOf(0x09);

function agentContext(): AgentContext {
  return {
    vault: VAULT,
    agent: agentKey.address,
    sign: signWith(agentKey.signer),
    energy: 30_000n,
    vaultNonce: () => Promise.resolve(5n),
    accountSequence: () => Promise.resolve(17n),
    now: () => NOW_MS,
  };
}

const requirements = newRequirements({
  network: CONCORDIUM_TESTNET,
  amount: 2_500_000n,
  payTo: AccountAddress.toBase58(addressOf(0x03)),
  feePayer: AccountAddress.toBase58(SPONSOR),
  provider: 10n,
  maxTimeoutSeconds: 45,
});

describe("createVaultPayment", () => {
  test("builds a sponsored V1 pay call, signed by the agent, that survives JSON", async () => {
    const payload = await createVaultPayment(requirements, agentContext());
    const wire = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const signable = Transaction.signableFromJSON(wire["signedTransaction"]);

    assert.equal(signable.version, 1);
    assert.ok(AccountAddress.equals(signable.header.sender, agentKey.address));
    assert.equal(signable.header.nonce.value, 17n);
    assert.equal(signable.header.expiry.expiryEpochSeconds, BigInt(NOW_MS / 1000 + 45));
    assert.equal(signable.header.executionEnergyAmount.value, 30_000n);
    assert.ok(signable.header.sponsor !== undefined);
    assert.ok(AccountAddress.equals(signable.header.sponsor.account, SPONSOR));

    const txPayload = signable.payload;
    assert.ok(txPayload.type === AccountTransactionType.Update);
    assert.ok(ContractAddress.equals(txPayload.address, VAULT));
    assert.equal(txPayload.receiveName.toString(), "guard_vault.pay");
    assert.equal(txPayload.amount.microCcdAmount, 0n);
    const params = decodePayParams(Parameter.toBuffer(txPayload.message));
    assert.equal(params.provider, 10n);
    assert.equal(params.amount, 2_500_000n);
    assert.equal(params.nonce, 5n);
    assert.deepEqual(params.invoiceHash, invoiceHash(parseRequirements(requirements)));

    assert.equal(
      await Transaction.verifySignature(signable, signable.signatures.sender, agentKey.account),
      true,
    );
    const stranger = ephemeralAccount(0x02);
    assert.equal(
      await Transaction.verifySignature(signable, signable.signatures.sender, stranger.account),
      false,
    );
  });

  test("VaultExactClient implements the x402 client scheme", async () => {
    const client = new VaultExactClient(agentContext());
    assert.equal(client.scheme, "vault-exact");
    const result = await client.createPaymentPayload(2, requirements);
    assert.equal(result.x402Version, 2);
    assert.ok("signedTransaction" in result.payload);
  });
});
