//! # GuardVault
//!
//! On-chain spending limits for an AI agent on Concordium **testnet**.
//!
//! This is the PR 1 skeleton. The contract records its owner when it is
//! initialized and exposes a read-only `owner` view. Caps, pause, nonce,
//! allowlist and `pay` land in later pull requests (see `SCOPE.md`).
#![no_std]

use concordium_std::*;

/// Contract state.
#[derive(Serialize, SchemaType)]
pub struct State {
    /// The account that initialized the vault. Only this account will be
    /// allowed to change rules (PR 2).
    owner: AccountAddress,
}

/// Initialize a vault. The account that sends the init transaction becomes
/// the owner.
///
/// Not payable. How the owner funds the vault is decided in PR 2.
#[init(contract = "guard_vault")]
fn init(ctx: &InitContext, _state_builder: &mut StateBuilder) -> InitResult<State> {
    Ok(State {
        owner: ctx.init_origin(),
    })
}

/// Return the owner account. Read-only.
#[receive(
    contract = "guard_vault",
    name = "owner",
    return_value = "AccountAddress"
)]
fn owner(_ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<AccountAddress> {
    Ok(host.state().owner)
}
