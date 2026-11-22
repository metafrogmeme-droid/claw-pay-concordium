# Badge check

`claw-pay-badge-check` tells the vault owner whether a CIS-8004 registry agent is **Verified by Concordium** and can go on the vault's allowlist. If it can, it prints the exact `add_provider` parameter.

```bash
node packages/badge-check/src/cli.ts fixtures/agent-views.v1.json --token 10 --card fixtures/agent-card.example.json
```

It uses only Node built-ins (Node 22.18+ runs the TypeScript directly). It does not use any hosted badge service: the card is fetched and hashed locally.

## What it checks

"Verified by Concordium" means the agent is **Active** in the Agent Registry and its **Agent Card**, fetched from `agent_uri`, has a **SHA-256 equal to the on-chain `metadata_hash`**.

That definition is from Concordium's badge documentation, as quoted in a third-party package's source. The docs site was not reachable from the build environment, so confirm it against `docs.concordium.com` on the operator box.

| Code | Meaning |
|---|---|
| `token-mismatch` | The reply is for a different token id than asked. |
| `not-active` | The registry status is not Active (for example Revoked). |
| `no-agent-uri` | The agent publishes no card. |
| `no-card-hash` | No `metadata_hash` on chain. |
| `card-unavailable` | The card could not be fetched (see limits). |
| `card-hash-mismatch` | The card's SHA-256 differs from `metadata_hash`. |
| `card-malformed` | The card is not UTF-8 JSON, not an object, or has no non-empty string `name`. |
| `no-agent-wallet` | Verified, but no `agent_wallet`. The vault pays only to that wallet, so the agent is not eligible. |

Outcomes:
- **Verified** means none of the first seven codes appeared.
- **Eligible** means verified, plus an `agent_wallet`.

Exit codes:
- `0`: eligible,
- `1`: not eligible,
- `2`: usage error or unreadable input.

The vault itself re-checks Active status and the approved card hash on **every** `pay`. This tool is the owner's check *before* approving a card hash.

## Input

The input is a JSON file with the raw reply of the registry's `agentOf` entrypoint:

```json
{ "token_id": 10, "agent_of_reply": "<hex of the reply bytes>" }
```

A file with an `agents` array of such entries, like `fixtures/agent-views.v1.json`, needs `--token <id>`.

To get a reply on the operator box, invoke `agentOf` on the official CIS-8004 registry instance:
- The parameter is the `AgentTokenId`: the byte `08`, then the token id as an 8-byte little-endian number. Token 10 is `080a00000000000000`.
- Save the returned bytes as hex.
- `concordium-client`'s contract invoke command can do this with a binary parameter. Check the exact flags against your installed version.

A built-in live query through `@concordium/web-sdk` arrives with the x402 and client work (PR 4b/5).

`--card <file>` checks an already downloaded card instead of fetching `agent_uri`.

## Fetch limits

When fetching `agent_uri`, the tool:
- uses **HTTPS only**,
- follows **no redirects**,
- waits at most **10 s**,
- accepts at most **64 KiB**.

It sends no credentials. Only the exact bytes are hashed.

## Using the result

When eligible, the last line is the `add_provider` parameter, for example:

```
add_provider parameter: {"token_id":10,"card_hash":"7acf0b1b…"}
```

The owner passes it to the vault's `add_provider`. If the provider later changes its card, the vault refuses payments (`CardHashMismatch`) until the owner runs this check again and re-approves.

## Tests

```bash
npm test --workspace @claw-pay-concordium/badge-check
```

What the tests cover:
- The decoder is tested against bytes written from the spec, and against the `agentOf` replies the contract tests write to `fixtures/agent-views.v1.json`.
- Card fetches are tested against a local server on 127.0.0.1. No test uses the outside network.
