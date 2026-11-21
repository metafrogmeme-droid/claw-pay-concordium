# Receipt verifier

`claw-pay-verify` rebuilds the GuardVault receipt chain from the vault's contract events alone and checks it. It takes nobody's word for anything: our logs, the agent's, or a block explorer's. It uses only Node built-ins (Node 22.18+ runs the TypeScript directly).

```bash
node packages/verifier/src/cli.ts fixtures/vault-events.v1.json
```

Exit codes:
- `0`: verified,
- `1`: verification failed (each issue is printed),
- `2`: usage error or unreadable input.

## What it checks

**Integrity of the chain**
- Each receipt's hash is the SHA-256 of its 208-byte body exactly as logged (`hash-mismatch`).
- Each receipt names this vault (`vault-mismatch`).
- Nonces run 0, 1, 2, … with no gaps (`nonce-gap`).
- Each `prev_hash` is the previous receipt's hash, or zeros for the first (`link-broken`).
- Timestamps never go backwards (`time-backwards`).
- The chain ends at the head the contract reports, and the count equals its next nonce (`head-mismatch`, `count-mismatch`). This catches a chain with receipts cut off the end.

**The rules, replayed from the owner's events.** `Initialized`, `CapsSet`, `AgentSet`, `PausedSet`, `ProviderAdded` and `ProviderRemoved` are applied in order. Every receipt is then checked against the rules in force at that point, the same way the contract checks a payment:
- paid by the current agent (`agent-mismatch`),
- not while paused (`paused`),
- to an allowlisted provider with its approved card hash (`provider-not-allowed`, `card-hash-mismatch`),
- `0 < amount <= per_tx_cap` (`zero-amount`, `per-tx-cap`),
- the UTC-day total within `daily_cap`, with the day being block time ÷ 86 400 s (`daily-cap`),
- no invoice paid twice (`invoice-reused`).

Undecodable events are reported as `decode-error`. If the file doesn't start with `Initialized`, the rules can't be replayed; that is reported as `missing-initialized`, and the integrity checks still run.

## What it cannot check

- **The registry's answer at payment time.** The vault asked the Agent Registry on chain, in the same transaction. The verifier sees only the vault's events.
- **That the payee was the registry's wallet.** Each receipt records the payee, and the vault paid it in the same transaction that logged the receipt.
- **The CCD transfer itself.** It is part of the same transaction as the receipt event, so both happened or neither did.
- **Where the events file came from.** The verifier checks the file it is given. To check a live vault, export its events from a node you trust, reading finalized blocks only. The exporter arrives with the client in PR 5 and runs on the operator box.

## Events file format

`claw-pay-concordium/vault-events/v1`:

```json
{
  "format": "claw-pay-concordium/vault-events/v1",
  "source": "where the events came from",
  "vault": { "index": 1, "subindex": 0 },
  "view": { "next_nonce": 4, "receipt_head": "<64 hex digits>" },
  "events": ["<hex of each vault event, in chain order>"]
}
```

- `events` are the raw logged bytes. The layouts are in `contracts/guard-vault/README.md`.
- `view` is what the vault's `view` entrypoint returns for `next_nonce` and `receipt_head`.

`fixtures/vault-events.v1.json` is produced by the Rust tests on the simulated chain (`golden_fixture_matches_contract`), so the verifier is always tested against bytes the contract really logs. Regenerate it after a contract change:

```bash
UPDATE_FIXTURES=1 cargo test --locked
```

## Tests

```bash
npm test --workspace @claw-pay-concordium/verifier
```

The golden fixture must verify. Tampered copies must each fail with the expected issue code:
- changed bytes,
- dropped, swapped or truncated receipts,
- a foreign vault,
- forged receipts that are hash-consistent but break the caps, reuse an invoice, come from another account, or pay while paused or to a removed provider.
