//! # GuardVault
//!
//! On-chain spending limits for an AI agent on Concordium **testnet**.
//!
//! The owner (the account that initializes the vault) funds it, sets the
//! caps, rotates the agent key, pauses, withdraws, and manages the provider
//! allowlist. The agent can only call `pay`. The owner can never be the
//! agent, so every payment is an agent action. The contract is not
//! upgradeable: to migrate, the owner pauses, withdraws and funds a new
//! instance.
//!
//! Providers are agents in Concordium's Agent Registry (CIS-8004), named by
//! their registry token id. The owner allowlists a provider together with the
//! SHA-256 of its agent card. The vault asks the registry when the provider is
//! added and again on every `pay`. The agent must be Active, its card hash
//! unchanged and its `agent_wallet` set. The payment goes to that wallet.
//!
//! Each `pay` must use the next nonce in sequence and an invoice hash that was
//! never paid before. It must stay within the per-payment cap and the daily
//! cap, which resets at 00:00 UTC. Every successful payment logs a `Receipt`
//! whose hash covers the previous receipt's hash, forming a public chain.
#![no_std]

pub mod cis8004;
mod limits;

use cis8004::{AgentStatus, AgentTokenId, AgentView};
use concordium_std::*;
use limits::{DailySpend, check_spend, utc_day, valid_caps};

/// SHA-256 hash of the invoice a payment settles.
pub type InvoiceHash = [u8; 32];
/// SHA-256 hash of a provider's agent card (CIS-8004 `metadata_hash`).
pub type CardHash = [u8; 32];
/// SHA-256 hash of a serialized `ReceiptBody`.
pub type ReceiptHash = [u8; 32];

/// Contract state.
#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    /// The account that initialized the vault. Never changes.
    owner: AccountAddress,
    /// The only account that may call `pay`. Never equal to `owner`.
    agent: AccountAddress,
    /// The CIS-8004 Agent Registry. Fixed at init.
    registry: ContractAddress,
    per_tx_cap: Amount,
    daily_cap: Amount,
    paused: bool,
    /// The nonce the next `pay` must use. Starts at 0. Also the number of
    /// receipts so far.
    next_nonce: u64,
    /// UTC day of the last successful payment.
    day: u64,
    /// Total paid during `day`.
    spent_today: Amount,
    /// Invoice hashes that have been paid.
    paid_invoices: StateSet<InvoiceHash, S>,
    /// Allowlist: registry token id to the card hash approved by the owner.
    providers: StateMap<u64, CardHash, S>,
    /// Hash of the last receipt; all zeros before the first payment.
    receipt_head: ReceiptHash,
}

/// Errors returned by the contract. New variants go at the end so existing
/// reject codes never change.
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
    /// The provider is not on the allowlist.
    ProviderNotAllowed,
    /// The registry reports the agent as not Active.
    ProviderNotActive,
    /// The agent's card hash in the registry differs from the approved one.
    CardHashMismatch,
    /// The agent has no `agent_wallet` in the registry.
    NoAgentWallet,
    /// The registry call failed or its reply could not be read.
    RegistryQueryFailed,
    /// An event could not be logged.
    LogFailed,
}

/// Parameter for `init`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct InitParams {
    pub agent: AccountAddress,
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
    /// The CIS-8004 Agent Registry instance.
    pub registry: ContractAddress,
}

/// Parameter for `set_caps`, and the `CapsSet` event.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct CapsParams {
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
}

/// Parameter for `add_provider`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct ProviderParams {
    /// Registry token id of the provider agent.
    pub token_id: u64,
    /// SHA-256 of the provider's agent card, as approved by the owner.
    pub card_hash: CardHash,
}

/// Parameter for `pay`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct PayParams {
    /// Registry token id of an allowlisted provider.
    pub provider: u64,
    pub amount: Amount,
    pub nonce: u64,
    pub invoice_hash: InvoiceHash,
}

/// Return value of `view`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct VaultView {
    pub owner: AccountAddress,
    pub agent: AccountAddress,
    pub registry: ContractAddress,
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
    pub paused: bool,
    /// Next nonce, which is also the number of receipts so far.
    pub next_nonce: u64,
    /// UTC day of the current block.
    pub current_day: u64,
    /// Total that counts against today's cap.
    pub spent_today: Amount,
    pub balance: Amount,
    /// Hash of the last receipt; all zeros before the first payment.
    pub receipt_head: ReceiptHash,
}

/// The hashed part of a receipt. `hash = sha256(to_bytes(&body))`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct ReceiptBody {
    /// This vault, so receipts from two vaults cannot be spliced together.
    pub vault: ContractAddress,
    pub nonce: u64,
    /// Hash of the previous receipt; all zeros for the first.
    pub prev_hash: ReceiptHash,
    /// Block time of the payment.
    pub timestamp: Timestamp,
    /// The agent account that paid.
    pub agent: AccountAddress,
    /// Registry token id of the provider.
    pub provider: u64,
    /// Card hash checked against the registry for this payment.
    pub card_hash: CardHash,
    /// The provider's `agent_wallet` that received the payment.
    pub payee: AccountAddress,
    pub amount: Amount,
    pub invoice_hash: InvoiceHash,
}

/// A receipt as logged: the body and its hash.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct ReceiptEvent {
    pub body: ReceiptBody,
    pub hash: ReceiptHash,
}

/// `Initialized` event data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct InitializedEvent {
    pub owner: AccountAddress,
    pub agent: AccountAddress,
    pub per_tx_cap: Amount,
    pub daily_cap: Amount,
    pub registry: ContractAddress,
}

/// `ProviderAdded` event data.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub struct ProviderAddedEvent {
    pub token_id: u64,
    pub card_hash: CardHash,
    /// The `agent_wallet` the registry reported when the provider was added.
    pub wallet: AccountAddress,
}

/// Events logged by the vault. The first byte of each event is the variant
/// index, so variants must only ever be appended.
// Events are built once and logged; the size difference between variants
// does not matter.
#[allow(clippy::large_enum_variant)]
#[derive(Debug, Clone, PartialEq, Eq, Serialize, SchemaType)]
pub enum Event {
    Initialized(InitializedEvent),
    Deposited(Amount),
    Withdrawn(Amount),
    CapsSet(CapsParams),
    AgentSet(AccountAddress),
    PausedSet(bool),
    ProviderAdded(ProviderAddedEvent),
    ProviderRemoved(u64),
    Receipt(ReceiptEvent),
}

fn log(logger: &mut Logger, event: &Event) -> Result<(), Error> {
    logger.log(event).map_err(|_| Error::LogFailed)
}

fn ensure_owner(ctx: &ReceiveContext, state: &State) -> Result<(), Error> {
    ensure!(ctx.sender().matches_account(&state.owner), Error::NotOwner);
    Ok(())
}

/// Ask the registry about `token_id`. Return the agent's wallet if the agent
/// is Active and its card hash equals `card_hash`.
fn verified_wallet(
    host: &Host<State>,
    token_id: u64,
    card_hash: &CardHash,
) -> Result<AccountAddress, Error> {
    let mut reply = host
        .invoke_contract_read_only(
            &host.state().registry,
            &AgentTokenId(token_id),
            EntrypointName::new_unchecked(cis8004::AGENT_OF),
            Amount::zero(),
        )
        .map_err(|_| Error::RegistryQueryFailed)?
        .ok_or(Error::RegistryQueryFailed)?;
    let view: AgentView = reply.get().map_err(|_| Error::RegistryQueryFailed)?;
    ensure!(
        view.token_id == AgentTokenId(token_id),
        Error::RegistryQueryFailed
    );
    ensure!(view.status == AgentStatus::Active, Error::ProviderNotActive);
    ensure!(
        view.metadata_hash.as_ref() == Some(card_hash),
        Error::CardHashMismatch
    );
    view.agent_wallet.ok_or(Error::NoAgentWallet)
}

/// Create a vault. The account sending this transaction becomes the owner.
/// Not payable: the owner funds the vault with `deposit`.
#[init(
    contract = "guard_vault",
    parameter = "InitParams",
    error = "Error",
    event = "Event",
    enable_logger
)]
fn init(
    ctx: &InitContext,
    state_builder: &mut StateBuilder,
    logger: &mut Logger,
) -> Result<State, Error> {
    let params: InitParams = ctx.parameter_cursor().get()?;
    let owner = ctx.init_origin();
    ensure!(params.agent != owner, Error::AgentIsOwner);
    ensure!(
        valid_caps(params.per_tx_cap, params.daily_cap),
        Error::InvalidCaps
    );
    log(
        logger,
        &Event::Initialized(InitializedEvent {
            owner,
            agent: params.agent,
            per_tx_cap: params.per_tx_cap,
            daily_cap: params.daily_cap,
            registry: params.registry,
        }),
    )?;
    Ok(State {
        owner,
        agent: params.agent,
        registry: params.registry,
        per_tx_cap: params.per_tx_cap,
        daily_cap: params.daily_cap,
        paused: false,
        next_nonce: 0,
        day: utc_day(ctx.metadata().slot_time()),
        spent_today: Amount::zero(),
        paid_invoices: state_builder.new_set(),
        providers: state_builder.new_map(),
        receipt_head: [0u8; 32],
    })
}

/// Owner only: add CCD to the vault.
#[receive(
    contract = "guard_vault",
    name = "deposit",
    error = "Error",
    payable,
    enable_logger
)]
fn deposit(
    ctx: &ReceiveContext,
    host: &Host<State>,
    amount: Amount,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    log(logger, &Event::Deposited(amount))
}

/// Owner only: send `amount` to the owner's account. Works while paused, so
/// the owner can migrate funds to a new instance.
#[receive(
    contract = "guard_vault",
    name = "withdraw",
    parameter = "Amount",
    error = "Error",
    enable_logger
)]
fn withdraw(ctx: &ReceiveContext, host: &Host<State>, logger: &mut Logger) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let amount: Amount = ctx.parameter_cursor().get()?;
    ensure!(amount > Amount::zero(), Error::ZeroAmount);
    ensure!(amount <= host.self_balance(), Error::InsufficientFunds);
    log(logger, &Event::Withdrawn(amount))?;
    host.invoke_transfer(&host.state().owner, amount)
        .map_err(|_| Error::TransferFailed)
}

/// Owner only: replace both caps. Today's running total is kept.
#[receive(
    contract = "guard_vault",
    name = "set_caps",
    parameter = "CapsParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_caps(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let params: CapsParams = ctx.parameter_cursor().get()?;
    ensure!(
        valid_caps(params.per_tx_cap, params.daily_cap),
        Error::InvalidCaps
    );
    let state = host.state_mut();
    state.per_tx_cap = params.per_tx_cap;
    state.daily_cap = params.daily_cap;
    log(logger, &Event::CapsSet(params))
}

/// Owner only: rotate the agent key. The owner cannot become the agent.
#[receive(
    contract = "guard_vault",
    name = "set_agent",
    parameter = "AccountAddress",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_agent(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let agent: AccountAddress = ctx.parameter_cursor().get()?;
    ensure!(agent != host.state().owner, Error::AgentIsOwner);
    host.state_mut().agent = agent;
    log(logger, &Event::AgentSet(agent))
}

/// Owner only: pause (`true`) or unpause (`false`) payments.
#[receive(
    contract = "guard_vault",
    name = "set_paused",
    parameter = "bool",
    error = "Error",
    mutable,
    enable_logger
)]
fn set_paused(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let paused: bool = ctx.parameter_cursor().get()?;
    host.state_mut().paused = paused;
    log(logger, &Event::PausedSet(paused))
}

/// Owner only: allowlist a registry agent with the approved card hash. The
/// registry must report it Active, with that card hash and a wallet. Adding
/// an existing token id replaces its card hash.
#[receive(
    contract = "guard_vault",
    name = "add_provider",
    parameter = "ProviderParams",
    error = "Error",
    mutable,
    enable_logger
)]
fn add_provider(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let params: ProviderParams = ctx.parameter_cursor().get()?;
    let wallet = verified_wallet(host, params.token_id, &params.card_hash)?;
    let _previous = host
        .state_mut()
        .providers
        .insert(params.token_id, params.card_hash);
    log(
        logger,
        &Event::ProviderAdded(ProviderAddedEvent {
            token_id: params.token_id,
            card_hash: params.card_hash,
            wallet,
        }),
    )
}

/// Owner only: remove a provider from the allowlist.
#[receive(
    contract = "guard_vault",
    name = "remove_provider",
    parameter = "u64",
    error = "Error",
    mutable,
    enable_logger
)]
fn remove_provider(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
) -> Result<(), Error> {
    ensure_owner(ctx, host.state())?;
    let token_id: u64 = ctx.parameter_cursor().get()?;
    ensure!(
        host.state().providers.get(&token_id).is_some(),
        Error::ProviderNotAllowed
    );
    host.state_mut().providers.remove(&token_id);
    log(logger, &Event::ProviderRemoved(token_id))
}

/// Agent only: pay `amount` to an allowlisted provider within the caps.
///
/// The cheap checks run first, then the registry check. State is updated
/// and the receipt logged before the transfer. Any error rolls the whole call
/// back, so a rejected payment changes nothing, logs nothing and uses no
/// nonce.
#[receive(
    contract = "guard_vault",
    name = "pay",
    parameter = "PayParams",
    error = "Error",
    mutable,
    enable_logger,
    crypto_primitives
)]
fn pay(
    ctx: &ReceiveContext,
    host: &mut Host<State>,
    logger: &mut Logger,
    crypto_primitives: &CryptoPrimitives,
) -> Result<(), Error> {
    let agent = host.state().agent;
    ensure!(ctx.sender().matches_account(&agent), Error::NotAgent);
    let params: PayParams = ctx.parameter_cursor().get()?;
    let now = ctx.metadata().slot_time();
    let balance = host.self_balance();

    let (card_hash, spend) = {
        let state = host.state();
        ensure!(!state.paused, Error::Paused);
        ensure!(params.nonce == state.next_nonce, Error::InvalidNonce);
        ensure!(
            !state.paid_invoices.contains(&params.invoice_hash),
            Error::InvoiceAlreadyPaid
        );
        let card_hash = state
            .providers
            .get(&params.provider)
            .map(|hash| *hash)
            .ok_or(Error::ProviderNotAllowed)?;
        let spend = check_spend(
            params.amount,
            state.per_tx_cap,
            state.daily_cap,
            DailySpend {
                day: state.day,
                spent: state.spent_today,
            },
            utc_day(now),
        )?;
        (card_hash, spend)
    };
    ensure!(params.amount <= balance, Error::InsufficientFunds);
    let payee = verified_wallet(host, params.provider, &card_hash)?;

    let state = host.state_mut();
    let body = ReceiptBody {
        vault: ctx.self_address(),
        nonce: params.nonce,
        prev_hash: state.receipt_head,
        timestamp: now,
        agent,
        provider: params.provider,
        card_hash,
        payee,
        amount: params.amount,
        invoice_hash: params.invoice_hash,
    };
    let hash = crypto_primitives.hash_sha2_256(&to_bytes(&body)).0;
    state.next_nonce = state.next_nonce.checked_add(1).ok_or(Error::Overflow)?;
    state.day = spend.day;
    state.spent_today = spend.spent;
    state.paid_invoices.insert(params.invoice_hash);
    state.receipt_head = hash;
    log(logger, &Event::Receipt(ReceiptEvent { body, hash }))?;

    host.invoke_transfer(&payee, params.amount)
        .map_err(|_| Error::TransferFailed)
}

/// Read the vault's settings, today's spend and the receipt chain head.
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
        registry: state.registry,
        per_tx_cap: state.per_tx_cap,
        daily_cap: state.daily_cap,
        paused: state.paused,
        next_nonce: state.next_nonce,
        current_day: today,
        spent_today: spend.effective(today),
        balance: host.self_balance(),
        receipt_head: state.receipt_head,
    })
}

/// The approved card hash for a provider, or `None` if not allowlisted.
#[receive(
    contract = "guard_vault",
    name = "provider",
    parameter = "u64",
    return_value = "Option<CardHash>",
    error = "Error"
)]
fn provider(ctx: &ReceiveContext, host: &Host<State>) -> Result<Option<CardHash>, Error> {
    let token_id: u64 = ctx.parameter_cursor().get()?;
    Ok(host.state().providers.get(&token_id).map(|hash| *hash))
}
