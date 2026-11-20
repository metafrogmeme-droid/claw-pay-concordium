# Claude brief — Claw Pay for Concordium

HUMANOID-TRADERS · RUNECLAW, Patrick Baur, CEO

Start in plan mode. Do not write or commit code until the plan is written down and agreed. After that, build on Accept edits.

This repo is the public hackathon entry **Claw Pay for Concordium**. Bootstrap (README, scope, threat model v0, license, gitignore, gitleaks CI) is already on `main`. Do not push to `main` again. Do not force-push. Do not merge. Every change goes in a **draft** pull request. Patrick approves each merge and the final submission.

## Stack

- Rust Concordium contracts (`GuardVault` and related).
- TypeScript agent client.
- Verifier CLI and, later, a verifier page.

Reuse decision rules (`decide` core) and the receipt-log idea from our earlier Claw Pay project only as specified in the scope. Concordium contracts, Agent Registry checks, the x402 flow and the verifier are new. When porting ideas, use these neutral names in this repo: **spend-policy**, **capped-signer**, **replay-guard**. Do not reuse names from our other paused products or from unpublished checkout code.

## Six draft PRs

Each PR is small, has tests, and waits for green CI.

1. Repo, CI, gitleaks, threat model v0 — extend this bootstrap: add tests, clippy/fmt and any missing CI. Do not redo the bootstrap commit.
2. Vault: caps, owner-only rules, pause, nonce.
3. Allowlist, receipts, verifier CLI.
4. Badge check, x402 seller spike.
5. Agent client, end-to-end testnet demo.
6. Verifier page, docs, path to production.

## Hard rules

- **Testnet only.** No mainnet, no real funds, no paid services.
- **Throwaway testnet keys.** Never commit keys or wallet exports. Load them from an environment variable. On our box they are mode 600. Do not generate, store or use keys in your environment for live transactions.
- **Draft PRs only.** Never merge. Never push to `main` after bootstrap. No force-pushes.
- **CI** must run tests, clippy/fmt (once Rust and TS exist) and gitleaks. Keep the existing gitleaks job. No scheduled workflows or cron.
- **Live testnet work stays on our box.** Deploys, transactions and anything that needs Concordium testnet run on our operator box, not in the Claude environment. Your session should not need new network hosts. Write the code and offline tests; leave live testnet steps for us.
- Copy only what the scope says to reuse, and only into draft PRs. Do not import unrelated product code.

## Scope and model

Read `SCOPE.md` and `THREAT_MODEL.md` first. They are the source of truth for in/out, architecture and mitigations. If a change would alter the frozen scope (mainnet, new trust assumptions, new paid services), stop and ask.
