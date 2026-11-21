# GuardVault contract

On-chain spending limits for an AI agent on Concordium **testnet**. Contract name: `guard_vault`. Rust, `concordium-std` 11, target `wasm32v1-none`.

## Roles

- **Owner:** the account that sends the init transaction. It never changes. It funds the vault, sets caps, rotates the agent, pauses and withdraws. It can never call `pay`.
- **Agent:** the only account that may call `pay`. It is always a different account from the owner.

Roles are checked against the transaction's sender, so a contract that the owner or agent calls cannot act in their name.

The contract is **not upgradeable**. To move to a new version, the owner pauses, withdraws and funds a new instance.

## Entrypoints

| Entrypoint | Caller | Parameter | Effect |
|---|---|---|---|
| `init_guard_vault` | becomes owner | `{ agent, per_tx_cap, daily_cap }` | Create the vault. Not payable. |
| `deposit` | owner | none, CCD attached | Add CCD to the vault. |
| `withdraw` | owner | `Amount` | Send CCD to the owner's own account. Works while paused. |
| `set_caps` | owner | `{ per_tx_cap, daily_cap }` | Replace both caps. Today's spend is kept. |
| `set_agent` | owner | `AccountAddress` | Rotate the agent key. The owner is refused. |
| `set_paused` | owner | `bool` | Pause or unpause payments. |
| `pay` | agent | `{ provider, amount, nonce, invoice_hash }` | Pay a provider account within the caps. |
| `view` | anyone | none | Owner, agent, caps, paused, next nonce, current UTC day, spend today, balance. |

Caps must satisfy `0 < per_tx_cap <= daily_cap`.

## Rules for `pay`

`pay` is checked in this order:

1. The sender is the agent.
2. The vault is not paused.
3. `nonce` is the next one in sequence. The first is 0, and `view` returns the next.
4. `invoice_hash` (32 bytes) has never been paid.
5. `amount` is greater than zero and at most `per_tx_cap`.
6. Today's total plus `amount` is at most `daily_cap`. "Today" is the UTC day of the block (block time ÷ 86 400 s), so the total resets at 00:00 UTC. Up to 2× `daily_cap` can therefore go out across midnight (see `THREAT_MODEL.md`).
7. The vault balance covers `amount`.

The contract updates its state before transferring. Any error rolls back the whole call, so a rejected `pay` changes nothing and uses no nonce. Providers are account addresses, so a payment never runs code.

## Errors

An init rejection carries only the code. Receive rejections also return the serialized error.

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

The test `error_codes_are_stable` pins these codes.

## Build and test

These steps need no network access to Concordium, no keys and no funds.

From this directory:

```bash
cargo concordium build --out concordium-out/module.wasm.v1
```

```bash
cargo test --locked
```

- Unit tests in `src/limits.rs` cover the cap arithmetic.
- Integration tests in `tests/guard_vault.rs` run the built module on the simulated chain from `concordium-smart-contract-testing`.
