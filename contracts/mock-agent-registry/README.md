# mock-agent-registry: TEST ONLY, NEVER DEPLOY

A minimal stand-in for Concordium's Agent Registry (CIS-8004). It exists only so the GuardVault integration tests can run against a registry on the simulated chain from `concordium-smart-contract-testing`.

**What it implements:**
- `agentOf(AgentTokenId) -> AgentView`, in the CIS-8004 wire format. An unknown token is rejected with `AgentNotFound` (-7200).
- `set_agent(AgentView)`, a test setter with **no access control**. It lets tests make an agent active, revoked, re-carded or re-walleted.

Because anyone can rewrite any agent, this contract must **never** be deployed to any network. The real registry address is passed to GuardVault at init on the operator box.

The types follow `source/CIS/cis-8004.rst` in `Concordium/concordium-update-proposals`. They are written separately from the vault's parser (`contracts/guard-vault/src/cis8004.rs`), so a mismatch between the two shows up in the tests.

Build it, from this directory:

```bash
cargo concordium build --out concordium-out/module.wasm.v1
```
