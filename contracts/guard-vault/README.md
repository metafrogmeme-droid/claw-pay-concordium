# GuardVault contract

On-chain spending limits for an AI agent on Concordium **testnet**. Contract name: `guard_vault`. Rust, `concordium-std` 11, target `wasm32v1-none`.

## Roles

- **Owner:** the account that sends the init transaction. It never changes. It funds the vault, sets caps, rotates the agent, pauses, withdraws, and manages the provider allowlist. It can never call `pay`.
- **Agent:** the only account that may call `pay`. It is always a different account from the owner.
- **Providers:** agents in Concordium's Agent Registry (CIS-8004), named by registry token id. Payments go to the provider's registry `agent_wallet`.

Roles are checked against the transaction's sender, so a contract that the owner or agent calls cannot act in their name.

The contract is **not upgradeable**. To move to a new version, the owner pauses, withdraws and funds a new instance.

## Agent Registry checks

The registry address is set at init and never changes. The owner must pass the official CIS-8004 registry instance for the network.

When the owner calls `add_provider`, and again on every `pay`, the vault calls `agentOf` on the registry and requires all of the following:
- the agent's status is **Active**,
- its `metadata_hash` (the SHA-256 of its agent card) equals the card hash the owner approved,
- it has an **`agent_wallet`**. The payment goes to that wallet.

So a provider that is revoked, changes its card, or drops its wallet is refused at once. If a provider changes its card, the owner approves the new hash with `add_provider` again. If the agent rotates its wallet in the registry, payments follow it.

## Entrypoints

| Entrypoint | Caller | Parameter | Effect |
|---|---|---|---|
| `init_guard_vault` | becomes owner | `{ agent, per_tx_cap, daily_cap, registry }` | Create the vault. Not payable. |
| `deposit` | owner | none, CCD attached | Add CCD to the vault. |
| `withdraw` | owner | `Amount` | Send CCD to the owner's own account. Works while paused. |
| `set_caps` | owner | `{ per_tx_cap, daily_cap }` | Replace both caps. Today's spend is kept. |
| `set_agent` | owner | `AccountAddress` | Rotate the agent key. The owner is refused. |
| `set_paused` | owner | `bool` | Pause or unpause payments. |
| `add_provider` | owner | `{ token_id: u64, card_hash: [u8; 32] }` | Allowlist a registry agent after checking it (see above). Re-adding replaces the card hash. |
| `remove_provider` | owner | `u64` (token id) | Remove a provider from the allowlist. |
| `pay` | agent | `{ provider: u64, amount, nonce, invoice_hash }` | Pay an allowlisted provider within the caps. |
| `view` | anyone | none | Owner, agent, registry, caps, paused, next nonce, current UTC day, spend today, balance, receipt head. |
| `provider` | anyone | `u64` (token id) | The approved card hash, or none if the provider isn't allowlisted. |

Caps must satisfy `0 < per_tx_cap <= daily_cap`.

## Rules for `pay`

`pay` is checked in this order:

1. The sender is the agent.
2. The vault is not paused.
3. `nonce` is the next one in sequence. The first is 0, and `view` returns the next.
4. `invoice_hash` (32 bytes) has never been paid.
5. `provider` is on the allowlist.
6. `amount` is greater than zero and at most `per_tx_cap`.
7. Today's total plus `amount` is at most `daily_cap`. "Today" is the UTC day of the block (block time ÷ 86 400 s), so the total resets at 00:00 UTC. Up to 2× `daily_cap` can therefore go out across midnight (see `THREAT_MODEL.md`).
8. The vault balance covers `amount`.
9. The registry check passes, and gives the payee wallet.

The contract then updates its state, logs the receipt, and transfers. Any error rolls back the whole call, so a rejected `pay` changes nothing, logs nothing and uses no nonce.

## Events and receipts

Each event starts with a one-byte tag, the variant index. Tags are append-only, and the test `event_tags_are_stable` pins them.

| Tag | Event | Data |
|---|---|---|
| 0 | `Initialized` | owner, agent, per_tx_cap, daily_cap, registry |
| 1 | `Deposited` | amount |
| 2 | `Withdrawn` | amount |
| 3 | `CapsSet` | per_tx_cap, daily_cap |
| 4 | `AgentSet` | agent |
| 5 | `PausedSet` | paused |
| 6 | `ProviderAdded` | token_id, card_hash, wallet |
| 7 | `ProviderRemoved` | token_id |
| 8 | `Receipt` | body (208 bytes), hash (32 bytes) |

A `Receipt` event is 241 bytes: `tag | body | hash`. The body is serialized as:

| Field | Bytes |
|---|---|
| `vault` (index, subindex) | 16 |
| `nonce` | 8 |
| `prev_hash` | 32 |
| `timestamp` (block time, ms) | 8 |
| `agent` | 32 |
| `provider` (token id) | 8 |
| `card_hash` | 32 |
| `payee` | 32 |
| `amount` (micro-CCD) | 8 |
| `invoice_hash` | 32 |

Integers are little-endian.
- `hash = SHA-256(body bytes)`.
- `prev_hash` is the previous receipt's hash, and all zeros for the first receipt.
- `view.receipt_head` is the latest hash, and `view.next_nonce` is the number of receipts.

To check a chain, a reader recomputes each hash over the body bytes as logged, follows the links, and compares the end with `view`. Including `vault` in the body stops receipts from two vaults being spliced together.

## Errors

An init rejection carries only the code. Receive rejections also return the serialized error. Codes are append-only, and the test `error_codes_are_stable` pins them.

| Code | Error | Meaning |
|---|---|---|
| -1 | `ParseParams` | The parameter could not be parsed. |
| -2 | `NotOwner` | Only the owner may call this. |
| -3 | `NotAgent` | Only the agent may call `pay`. |
| -4 | `AgentIsOwner` | The agent must differ from the owner. |
| -5 | `InvalidCaps` | Caps must satisfy `0 < per_tx_cap <= daily_cap`. |
| -6 | `Paused` | The vault is paused. |
| -7 | `InvalidNonce` | The nonce is not the next in sequence. |
| -8 | `InvoiceAlreadyPaid` | This invoice hash was already paid. |
| -9 | `ZeroAmount` | The amount must be greater than zero. |
| -10 | `ExceedsPerTxCap` | The amount is above the per-payment cap. |
| -11 | `ExceedsDailyCap` | Today's total would exceed the daily cap. |
| -12 | `InsufficientFunds` | The vault balance is too low. |
| -13 | `Overflow` | An internal counter would overflow. |
| -14 | `TransferFailed` | The CCD transfer failed. |
| -15 | `ProviderNotAllowed` | The provider is not on the allowlist. |
| -16 | `ProviderNotActive` | The registry reports the agent as not Active. |
| -17 | `CardHashMismatch` | The registry card hash differs from the approved one. |
| -18 | `NoAgentWallet` | The agent has no `agent_wallet` in the registry. |
| -19 | `RegistryQueryFailed` | The registry call failed, for example for an unknown token id. |
| -20 | `LogFailed` | An event could not be logged. |

## Build and test

These steps need no network access to Concordium, no keys and no funds. The tests use the test-only registry in `../mock-agent-registry`, which must never be deployed.

```bash
(cd contracts/guard-vault && cargo concordium build --out concordium-out/module.wasm.v1)
```

```bash
(cd contracts/mock-agent-registry && cargo concordium build --out concordium-out/module.wasm.v1)
```

```bash
cargo test --locked
```

What the tests cover:
- `src/limits.rs`: unit tests for the cap arithmetic.
- `src/cis8004.rs`: unit tests that decode registry bytes written from the spec.
- `tests/guard_vault.rs`: runs both built modules on the simulated chain from `concordium-smart-contract-testing`.
