//! # GuardVault
//!
//! On-chain spending limits for an AI agent on Concordium **testnet**.
//!
//! The owner (the account that initializes the vault) funds it, sets the
//! caps, rotates the agent key, pauses, and withdraws. The agent can only call
//! `pay`. The owner can never be the agent, so every payment is an agent
//! action. The contract is not upgradeable: to migrate, the owner pauses,
//! withdraws and funds a new instance.
//!
//! Each `pay` must use the next nonce in sequence and an invoice hash that was
//! never paid before. It must stay within the per-payment cap and the daily
//! cap, which resets at 00:00 UTC. Providers are account addresses, so a
//! payment never runs code.
//!
//! Allowlist and receipts land in PR 3 (see `SCOPE.md`).
#![no_std]

mod limits;

use concordium_std::*;
use limits::{DailySpend, check_spend, utc_day, valid_caps};

/// SHA-256 hash of the invoice a payment settles.
pub type InvoiceHash = [u8; 32];

/// Contract state.
#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    /// The account that initialized the vault. Never changes.
    owner: AccountAddress,
    /// The only account that may call `pay`. Never equal to `owner`.
    agent: AccountAddress,
    per_tx_cap: Amount,
    daily_cap: Amount,
    paused: bool,
    /// The nonce the next `pay` must use. Starts at 0.
    next_nonce: u64,
    /// UTC day of the last successful payment.
    day: u64,
    /// Total paid during `day`.
    spent_today: Amount,
    /// Invoice hashes that have been paid.
    paid_invoices: StateSet<InvoiceHash, S>,
}

/// Errors returned by the contract.
#[derive(Debug, PartialEq, Eq, Reject, Serialize, SchemaType)]
pub enum Error {
    /// The parameter could not be parsed.
    #[from(ParseError)]
    ParseParams,
    /// Only the owner may call this entrypoint.
    NotOwner,
    /// Only the agent may call `pay`.
    NotAgent,
    /// The agent must be a different account from the owner.
    AgentIsOwner,
    /// Caps must satisfy `0 < per_tx_cap <= daily_cap`.
    InvalidCaps,
    /// The vault is paused.
    Paused,
    /// The nonce is not the next one in sequence.
    InvalidNonce,
    /// This invoice hash has already been paid.
    InvoiceAlreadyPaid,
    /// Amounts must be greater than zero.
    ZeroAmount,
    /// The amount is above the per-payment cap.
    ExceedsPerTxCap,
    /// The payment would take today's total above the daily cap.
    ExceedsDailyCap,
    /// The vault balance does not cover the amount.
    InsufficientFunds,
    /// An internal counter would overflow.
    Overflow,
    /// The CCD transfer failed.
    TransferFailed,
}

/// Parameter for `init`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct InitParams {
    pub agent: AccountAddress,
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
}

/// Parameter for `set_caps`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct CapsParams {
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
}

/// Parameter for `pay`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct PayParams {
    pub provider: AccountAddress,
    pub amount: Amount,
    pub nonce: u64,
    pub invoice_hash: InvoiceHash,
}

/// Return value of `view`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct VaultView {
    pub owner: AccountAddress,
    pub agent: AccountAddress,
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
    pub paused: bool,
    pub next_nonce: u64,
    /// UTC day of the current block.
    pub current_day: u64,
    /// Total that counts against today's cap.
    pub spent_today: Amount,
    pub balance: Amount,
}

fn ensure_owner(ctx: &ReceiveContext, state: &State) -> Result<(), Error> {
    ensure!(ctx.sender().matches_account(&state.owner), Error::NotOwner);
    Ok(())
}

/// Create a vault. The account sending this transaction becomes the owner.
/// Not payable: the owner funds the vault with `deposit`.
#[init(contract = "guard_vault", parameter = "InitParams", error = "Error")]
fn init(ctx: &InitContext, state_builder: &mut StateBuilder) -> Result<State, Error> {
    let params: InitParams = ctx.parameter_cursor().get()?;
    let owner = ctx.init_origin();
    ensure!(params.agent != owner, Error::AgentIsOwner);
    ensure!(
        valid_caps(params.per_tx_cap, params.daily_cap),
        Error::InvalidCaps
    );
    Ok(State {
        owner,
        agent: params.agent,
        per_tx_cap: params.per_tx_cap,
        daily_cap: params.daily_cap,
        paused: false,
        next_nonce: 0,
        day: utc_day(ctx.metadata().slot_time()),
        spent_today: Amount::zero(),
        paid_invoices: state_builder.new_set(),
    })
}

/// Owner only: add CCD to the vault.
#[receive(contract = "guard_vault", name = "deposit", error = "Error", payable)]
fn deposit(ctx: &ReceiveContext, host: &Host<State>, _amount: Amount) -> Result<(), Error> {
    ensure_owner(ctx, host.state())
}

/// Owner only: send `amount` to the owner's account. Works while paused, so
/// the owner can migrate funds to a new instance.
#[receive(
    contract = "guard_vault",
    name = "withdraw",
    parameter = "Amount",
    error = "Error"
)]
fn withdraw(ctx: &ReceiveContext, host: &Host<State>) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let amount: Amount = ctx.parameter_cursor().get()?;
    ensure!(amount > Amount::zero(), Error::ZeroAmount);
    ensure!(amount <= host.self_balance(), Error::InsufficientFunds);
    host.invoke_transfer(&host.state().owner, amount)
        .map_err(|_| Error::TransferFailed)
}

/// Owner only: replace both caps. Today's running total is kept.
#[receive(
    contract = "guard_vault",
    name = "set_caps",
    parameter = "CapsParams",
    error = "Error",
    mutable
)]
fn set_caps(ctx: &ReceiveContext, host: &mut Host<State>) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let params: CapsParams = ctx.parameter_cursor().get()?;
    ensure!(
        valid_caps(params.per_tx_cap, params.daily_cap),
        Error::InvalidCaps
    );
    let state = host.state_mut();
    state.per_tx_cap = params.per_tx_cap;
    state.daily_cap = params.daily_cap;
    Ok(())
}

/// Owner only: rotate the agent key. The owner cannot become the agent.
#[receive(
    contract = "guard_vault",
    name = "set_agent",
    parameter = "AccountAddress",
    error = "Error",
    mutable
)]
fn set_agent(ctx: &ReceiveContext, host: &mut Host<State>) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let agent: AccountAddress = ctx.parameter_cursor().get()?;
    ensure!(agent != host.state().owner, Error::AgentIsOwner);
    host.state_mut().agent = agent;
    Ok(())
}

/// Owner only: pause (`true`) or unpause (`false`) payments.
#[receive(
    contract = "guard_vault",
    name = "set_paused",
    parameter = "bool",
    error = "Error",
    mutable
)]
fn set_paused(ctx: &ReceiveContext, host: &mut Host<State>) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let paused: bool = ctx.parameter_cursor().get()?;
    host.state_mut().paused = paused;
    Ok(())
}

/// Agent only: pay `amount` to `provider` within the caps.
///
/// State is updated before the transfer. Any error rolls the whole call
/// back, so a rejected payment changes nothing and uses no nonce.
#[receive(
    contract = "guard_vault",
    name = "pay",
    parameter = "PayParams",
    error = "Error",
    mutable
)]
fn pay(ctx: &ReceiveContext, host: &mut Host<State>) -> Result<(), Error> {
    ensure!(
        ctx.sender().matches_account(&host.state().agent),
        Error::NotAgent
    );
    let params: PayParams = ctx.parameter_cursor().get()?;
    let today = utc_day(ctx.metadata().slot_time());
    let balance = host.self_balance();

    let state = host.state_mut();
    ensure!(!state.paused, Error::Paused);
    ensure!(params.nonce == state.next_nonce, Error::InvalidNonce);
    ensure!(
        !state.paid_invoices.contains(&params.invoice_hash),
        Error::InvoiceAlreadyPaid
    );
    let spend = check_spend(
        params.amount,
        state.per_tx_cap,
        state.daily_cap,
        DailySpend {
            day: state.day,
            spent: state.spent_today,
        },
        today,
    )?;
    ensure!(params.amount <= balance, Error::InsufficientFunds);

    state.next_nonce = state.next_nonce.checked_add(1).ok_or(Error::Overflow)?;
    state.day = spend.day;
    state.spent_today = spend.spent;
    state.paid_invoices.insert(params.invoice_hash);

    host.invoke_transfer(&params.provider, params.amount)
        .map_err(|_| Error::TransferFailed)
}

/// Read the vault's settings and today's spend.
#[receive(
    contract = "guard_vault",
    name = "view",
    return_value = "VaultView",
    error = "Error"
)]
fn view(ctx: &ReceiveContext, host: &Host<State>) -> Result<VaultView, Error> {
    let state = host.state();
    let today = utc_day(ctx.metadata().slot_time());
    let spend = DailySpend {
        day: state.day,
        spent: state.spent_today,
    };
    Ok(VaultView {
        owner: state.owner,
        agent: state.agent,
        per_tx_cap: state.per_tx_cap,
        daily_cap: state.daily_cap,
        paused: state.paused,
        next_nonce: state.next_nonce,
        current_day: today,
        spent_today: spend.effective(today),
        balance: host.self_balance(),
    })
}
