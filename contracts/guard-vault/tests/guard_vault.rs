//! Integration tests for GuardVault.
//!
//! They run against the compiled Wasm modules on the simulated chain from
//! `concordium-smart-contract-testing`. No network, no real keys: the
//! accounts below are fixed byte arrays that exist only in the simulator. The
//! Agent Registry is the test-only `mock-agent-registry` contract.
//!
//! Build both modules first:
//!
//! ```text
//! (cd contracts/guard-vault && cargo concordium build --out concordium-out/module.wasm.v1)
//! (cd contracts/mock-agent-registry && cargo concordium build --out concordium-out/module.wasm.v1)
//! ```
//!
//! Test names refer to the invariants in `THREAT_MODEL.md`.

use concordium_smart_contract_testing::*;
use concordium_std::Serial;
use guard_vault::cis8004::{
    AgentStatus, AgentTokenId, AgentView, ExternalKeyId, ExternalRefKind, ExternalReference,
};
use guard_vault::{
    CapsParams, CardHash, Error, Event, InitParams, InitializedEvent, InvoiceHash, PayParams,
    ProviderAddedEvent, ProviderParams, ReceiptEvent, VaultView,
};
use sha2::{Digest, Sha256};

const OWNER: AccountAddress = AccountAddress([1u8; 32]);
const AGENT: AccountAddress = AccountAddress([2u8; 32]);
/// `agent_wallet` of registry agent 1.
const PROVIDER: AccountAddress = AccountAddress([3u8; 32]);
const OUTSIDER: AccountAddress = AccountAddress([4u8; 32]);
const NEW_AGENT: AccountAddress = AccountAddress([5u8; 32]);
/// A second wallet, for rotation and for registry agent 2.
const NEW_WALLET: AccountAddress = AccountAddress([6u8; 32]);
/// The account holding the registry agent NFTs.
const NFT_HOLDER: AccountAddress = AccountAddress([7u8; 32]);

/// Registry agent allowlisted in every `Env`.
const AGENT_1: u64 = 1;
/// Registry agent that is Active but not allowlisted.
const AGENT_2: u64 = 2;
const CARD_1: CardHash = [0xC1; 32];
const CARD_2: CardHash = [0xC2; 32];

const ACCOUNT_BALANCE: Amount = Amount::from_ccd(10_000);
const PER_TX_CAP: Amount = Amount::from_ccd(5);
const DAILY_CAP: Amount = Amount::from_ccd(10);
const FUNDING: Amount = Amount::from_ccd(100);

const SIGNER: Signer = Signer::with_one_key();
const ENERGY: u64 = 100_000;

const DAY_MILLIS: u64 = 86_400_000;
/// 2026-11-21 is UTC day 20 778. Tests start at 12:00 UTC that day.
const START_DAY: u64 = 20_778;
const START_MILLIS: u64 = START_DAY * DAY_MILLIS + 12 * 3_600_000;

fn ccd(n: u64) -> Amount {
    Amount::from_ccd(n)
}

fn invoice(id: u8) -> InvoiceHash {
    [id; 32]
}

fn sha256(bytes: &[u8]) -> [u8; 32] {
    Sha256::digest(bytes).into()
}

/// The reject code the contract uses for `error`.
fn reject_code(error: Error) -> i32 {
    concordium_std::Reject::from(error).error_code.get()
}

/// Path of a module built by `cargo concordium build` in `crate_dir`.
fn module_path(crate_dir: &str) -> String {
    format!(
        "{}/../{crate_dir}/concordium-out/module.wasm.v1",
        env!("CARGO_MANIFEST_DIR")
    )
}

fn load_module(chain: &mut Chain, crate_dir: &str) -> ModuleReference {
    let module = module_load_v1(module_path(crate_dir))
        .unwrap_or_else(|_| panic!("{crate_dir} module exists; run `cargo concordium build`"));
    chain
        .module_deploy_v1(SIGNER, OWNER, module)
        .expect("module deploys")
        .module_reference
}

/// A registry record for `token_id`, with the given status, card and wallet.
fn agent_record(
    token_id: u64,
    status: AgentStatus,
    card: Option<CardHash>,
    wallet: Option<AccountAddress>,
) -> AgentView {
    let revoked = status == AgentStatus::Revoked;
    AgentView {
        token_id: AgentTokenId(token_id),
        owner_account: NFT_HOLDER,
        agent_uri: Some("https://agent.example/card.json".to_string()),
        metadata_hash: card,
        external_reference: None,
        agent_wallet: wallet,
        status,
        registered_at: Timestamp::from_timestamp_millis(START_MILLIS - DAY_MILLIS),
        revoked_at: revoked.then(|| Timestamp::from_timestamp_millis(START_MILLIS)),
        revocation_reason: revoked.then(|| "revoked in test".to_string()),
    }
}

fn active(token_id: u64, card: CardHash, wallet: AccountAddress) -> AgentView {
    agent_record(token_id, AgentStatus::Active, Some(card), Some(wallet))
}

struct Modules {
    vault: ModuleReference,
    registry: ModuleReference,
}

/// A chain at `START_MILLIS` with funded accounts and both modules deployed.
fn new_chain() -> (Chain, Modules) {
    let mut chain = Chain::builder()
        .block_time(Timestamp::from_timestamp_millis(START_MILLIS))
        .build()
        .expect("chain builds");
    for account in [
        OWNER, AGENT, PROVIDER, OUTSIDER, NEW_AGENT, NEW_WALLET, NFT_HOLDER,
    ] {
        chain.create_account(Account::new(account, ACCOUNT_BALANCE));
    }
    let vault = load_module(&mut chain, "guard-vault");
    let registry = load_module(&mut chain, "mock-agent-registry");
    (chain, Modules { vault, registry })
}

fn init_registry(chain: &mut Chain, module: ModuleReference) -> ContractAddress {
    chain
        .contract_init(
            SIGNER,
            OUTSIDER,
            Energy::from(ENERGY),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref: module,
                init_name: OwnedContractName::new_unchecked("init_mock_agent_registry".to_string()),
                param: OwnedParameter::empty(),
            },
        )
        .expect("registry initializes")
        .contract_address
}

fn default_params(registry: ContractAddress) -> InitParams {
    InitParams {
        agent: AGENT,
        per_tx_cap: PER_TX_CAP,
        daily_cap: DAILY_CAP,
        registry,
    }
}

/// Initialize a vault from `sender`. An init rejection carries only the
/// reject code (no return value), so that is what the error holds.
fn init_vault(
    chain: &mut Chain,
    module: ModuleReference,
    sender: AccountAddress,
    params: &InitParams,
) -> Result<ContractInitSuccess, i32> {
    chain
        .contract_init(
            SIGNER,
            sender,
            Energy::from(ENERGY),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref: module,
                init_name: OwnedContractName::new_unchecked("init_guard_vault".to_string()),
                param: OwnedParameter::from_serial(params).expect("parameter fits"),
            },
        )
        .map_err(|err| match err.kind {
            ContractInitErrorKind::ExecutionError {
                error: InitExecutionError::Reject { reason, .. },
                ..
            } => reason,
            other => panic!("unexpected init failure: {other:?}"),
        })
}

/// A funded vault with a registry. OWNER is the owner, AGENT the agent,
/// FUNDING deposited, and registry agent 1 (Active, CARD_1, wallet PROVIDER)
/// allowlisted. Registry agent 2 (Active, CARD_2, wallet NEW_WALLET) exists
/// but is not allowlisted.
struct Env {
    chain: Chain,
    vault: ContractAddress,
    registry: ContractAddress,
}

impl Env {
    fn new() -> Self {
        let (mut chain, modules) = new_chain();
        let registry = init_registry(&mut chain, modules.registry);
        let vault = init_vault(&mut chain, modules.vault, OWNER, &default_params(registry))
            .expect("init succeeds")
            .contract_address;
        let mut env = Env {
            chain,
            vault,
            registry,
        };
        env.set_record(&active(AGENT_1, CARD_1, PROVIDER));
        env.set_record(&active(AGENT_2, CARD_2, NEW_WALLET));
        env.call_with(OWNER, "deposit", &(), FUNDING)
            .expect("owner deposits");
        env.add_provider(AGENT_1, CARD_1)
            .expect("owner adds agent 1");
        env
    }

    /// Create or replace a record in the mock registry.
    fn set_record(&mut self, record: &AgentView) {
        self.chain
            .contract_update(
                SIGNER,
                OUTSIDER,
                Address::Account(OUTSIDER),
                Energy::from(ENERGY),
                UpdateContractPayload {
                    amount: Amount::zero(),
                    address: self.registry,
                    receive_name: OwnedReceiveName::new_unchecked(
                        "mock_agent_registry.set_agent".to_string(),
                    ),
                    message: OwnedParameter::from_serial(record).expect("parameter fits"),
                },
            )
            .expect("registry accepts the record");
    }

    fn call_with<P: Serial>(
        &mut self,
        sender: AccountAddress,
        entrypoint: &str,
        param: &P,
        amount: Amount,
    ) -> Result<ContractInvokeSuccess, Error> {
        self.chain
            .contract_update(
                SIGNER,
                sender,
                Address::Account(sender),
                Energy::from(ENERGY),
                UpdateContractPayload {
                    amount,
                    address: self.vault,
                    receive_name: OwnedReceiveName::new_unchecked(format!(
                        "guard_vault.{entrypoint}"
                    )),
                    message: OwnedParameter::from_serial(param).expect("parameter fits"),
                },
            )
            .map_err(|err| {
                err.parse_return_value::<Error>()
                    .expect("return value is a contract Error")
            })
    }

    fn call<P: Serial>(
        &mut self,
        sender: AccountAddress,
        entrypoint: &str,
        param: &P,
    ) -> Result<ContractInvokeSuccess, Error> {
        self.call_with(sender, entrypoint, param, Amount::zero())
    }

    fn add_provider(
        &mut self,
        token_id: u64,
        card_hash: CardHash,
    ) -> Result<ContractInvokeSuccess, Error> {
        self.call(
            OWNER,
            "add_provider",
            &ProviderParams {
                token_id,
                card_hash,
            },
        )
    }

    fn pay_to(
        &mut self,
        sender: AccountAddress,
        provider: u64,
        nonce: u64,
        amount: Amount,
        invoice_id: u8,
    ) -> Result<ContractInvokeSuccess, Error> {
        let params = PayParams {
            provider,
            amount,
            nonce,
            invoice_hash: invoice(invoice_id),
        };
        self.call(sender, "pay", &params)
    }

    /// Pay registry agent 1.
    fn pay(
        &mut self,
        sender: AccountAddress,
        nonce: u64,
        amount: Amount,
        invoice_id: u8,
    ) -> Result<ContractInvokeSuccess, Error> {
        self.pay_to(sender, AGENT_1, nonce, amount, invoice_id)
    }

    fn invoke_view<P: Serial>(&self, entrypoint: &str, param: &P) -> ContractInvokeSuccess {
        self.chain
            .contract_invoke(
                OUTSIDER,
                Address::Account(OUTSIDER),
                Energy::from(ENERGY),
                UpdateContractPayload {
                    amount: Amount::zero(),
                    address: self.vault,
                    receive_name: OwnedReceiveName::new_unchecked(format!(
                        "guard_vault.{entrypoint}"
                    )),
                    message: OwnedParameter::from_serial(param).expect("parameter fits"),
                },
            )
            .expect("view succeeds")
    }

    fn view(&self) -> VaultView {
        self.invoke_view("view", &())
            .parse_return_value()
            .expect("return value is a VaultView")
    }

    fn provider_card(&self, token_id: u64) -> Option<CardHash> {
        self.invoke_view("provider", &token_id)
            .parse_return_value()
            .expect("return value is an Option<CardHash>")
    }

    fn balance_of(&self, account: AccountAddress) -> Amount {
        self.chain
            .account_balance_available(account)
            .expect("account exists")
    }

    fn vault_balance(&self) -> Amount {
        self.chain
            .contract_balance(self.vault)
            .expect("vault exists")
    }

    /// Move block time forward to `millis` since the Unix epoch.
    fn set_time(&mut self, millis: u64) {
        let now = self.chain.block_time().timestamp_millis();
        self.chain
            .tick_block_time(Duration::from_millis(millis - now))
            .expect("time moves forward");
    }
}

/// The vault events logged by an update, decoded.
fn vault_events(env: &Env, result: &ContractInvokeSuccess) -> Vec<Event> {
    raw_vault_events(env, result)
        .iter()
        .map(|bytes| concordium_std::from_bytes(bytes).expect("event is a vault Event"))
        .collect()
}

/// The vault events logged by an update, as raw bytes.
fn raw_vault_events(env: &Env, result: &ContractInvokeSuccess) -> Vec<Vec<u8>> {
    result
        .events()
        .filter(|(address, _)| *address == env.vault)
        .flat_map(|(_, events)| events.iter())
        .map(|event| AsRef::<Vec<u8>>::as_ref(event).clone())
        .collect()
}

/// The single `Receipt` logged by a successful `pay`.
fn receipt_of(env: &Env, result: &ContractInvokeSuccess) -> ReceiptEvent {
    match vault_events(env, result).as_slice() {
        [Event::Receipt(receipt)] => receipt.clone(),
        other => panic!("expected exactly one Receipt, got {other:?}"),
    }
}

/// Clients decode rejections by code (see `contracts/guard-vault/README.md`),
/// so the codes must not shift when variants are added.
#[test]
fn error_codes_are_stable() {
    let expected = [
        (Error::ParseParams, -1),
        (Error::NotOwner, -2),
        (Error::NotAgent, -3),
        (Error::AgentIsOwner, -4),
        (Error::InvalidCaps, -5),
        (Error::Paused, -6),
        (Error::InvalidNonce, -7),
        (Error::InvoiceAlreadyPaid, -8),
        (Error::ZeroAmount, -9),
        (Error::ExceedsPerTxCap, -10),
        (Error::ExceedsDailyCap, -11),
        (Error::InsufficientFunds, -12),
        (Error::Overflow, -13),
        (Error::TransferFailed, -14),
        (Error::ProviderNotAllowed, -15),
        (Error::ProviderNotActive, -16),
        (Error::CardHashMismatch, -17),
        (Error::NoAgentWallet, -18),
        (Error::RegistryQueryFailed, -19),
        (Error::LogFailed, -20),
    ];
    for (error, code) in expected {
        assert_eq!(reject_code(error), code);
    }
}

mod init {
    use super::*;

    #[test]
    fn init_sets_owner_agent_caps_and_registry() {
        let env = Env::new();
        assert_eq!(
            env.view(),
            VaultView {
                owner: OWNER,
                agent: AGENT,
                registry: env.registry,
                per_tx_cap: PER_TX_CAP,
                daily_cap: DAILY_CAP,
                paused: false,
                next_nonce: 0,
                current_day: START_DAY,
                spent_today: Amount::zero(),
                balance: FUNDING,
                receipt_head: [0u8; 32],
            }
        );
    }

    #[test]
    fn init_logs_initialized() {
        let (mut chain, modules) = new_chain();
        let registry = ContractAddress::new(999, 0);
        let init = init_vault(&mut chain, modules.vault, OWNER, &default_params(registry))
            .expect("init succeeds");
        let events: Vec<Event> = init
            .events
            .iter()
            .map(|e| e.parse().expect("event is a vault Event"))
            .collect();
        assert_eq!(
            events,
            vec![Event::Initialized(InitializedEvent {
                owner: OWNER,
                agent: AGENT,
                per_tx_cap: PER_TX_CAP,
                daily_cap: DAILY_CAP,
                registry,
            })]
        );
    }

    #[test]
    fn inv10_init_rejects_agent_equal_to_owner() {
        let (mut chain, modules) = new_chain();
        let params = InitParams {
            agent: OWNER,
            ..default_params(ContractAddress::new(999, 0))
        };
        assert_eq!(
            init_vault(&mut chain, modules.vault, OWNER, &params).err(),
            Some(reject_code(Error::AgentIsOwner))
        );
    }

    #[test]
    fn init_rejects_invalid_caps() {
        let (mut chain, modules) = new_chain();
        let base = default_params(ContractAddress::new(999, 0));
        let per_tx_above_daily = InitParams {
            per_tx_cap: ccd(11),
            ..base.clone()
        };
        let zero_per_tx = InitParams {
            per_tx_cap: Amount::zero(),
            ..base
        };
        for params in [per_tx_above_daily, zero_per_tx] {
            assert_eq!(
                init_vault(&mut chain, modules.vault, OWNER, &params).err(),
                Some(reject_code(Error::InvalidCaps))
            );
        }
    }
}

mod owner_rules {
    use super::*;

    #[test]
    fn inv1_agent_and_outsider_cannot_change_rules() {
        let mut env = Env::new();
        let before = env.view();
        let caps = CapsParams {
            per_tx_cap: ccd(1),
            daily_cap: ccd(1),
        };
        let provider = ProviderParams {
            token_id: AGENT_2,
            card_hash: CARD_2,
        };
        for sender in [AGENT, OUTSIDER] {
            assert_eq!(
                env.call(sender, "set_caps", &caps).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call(sender, "set_agent", &NEW_AGENT).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call(sender, "set_paused", &true).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call(sender, "withdraw", &ccd(1)).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call_with(sender, "deposit", &(), ccd(1)).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call(sender, "add_provider", &provider).err(),
                Some(Error::NotOwner)
            );
            assert_eq!(
                env.call(sender, "remove_provider", &AGENT_1).err(),
                Some(Error::NotOwner)
            );
        }
        assert_eq!(env.view(), before);
        assert_eq!(env.provider_card(AGENT_1), Some(CARD_1));
        assert_eq!(env.provider_card(AGENT_2), None);
    }

    #[test]
    fn owner_changes_caps_pause_and_agent() {
        let mut env = Env::new();
        let caps = CapsParams {
            per_tx_cap: ccd(2),
            daily_cap: ccd(4),
        };
        env.call(OWNER, "set_caps", &caps).expect("owner sets caps");
        env.call(OWNER, "set_paused", &true).expect("owner pauses");
        env.call(OWNER, "set_agent", &NEW_AGENT)
            .expect("owner rotates agent");
        env.call_with(OWNER, "deposit", &(), ccd(1))
            .expect("owner deposits");

        let view = env.view();
        assert_eq!(view.per_tx_cap, ccd(2));
        assert_eq!(view.daily_cap, ccd(4));
        assert!(view.paused);
        assert_eq!(view.agent, NEW_AGENT);
        assert_eq!(view.balance, ccd(101));

        env.call(OWNER, "set_paused", &false)
            .expect("owner unpauses");
        assert!(!env.view().paused);
    }

    #[test]
    fn set_caps_rejects_invalid_caps() {
        let mut env = Env::new();
        for caps in [
            CapsParams {
                per_tx_cap: ccd(5),
                daily_cap: ccd(4),
            },
            CapsParams {
                per_tx_cap: Amount::zero(),
                daily_cap: ccd(4),
            },
        ] {
            assert_eq!(
                env.call(OWNER, "set_caps", &caps).err(),
                Some(Error::InvalidCaps)
            );
        }
    }

    #[test]
    fn inv10_set_agent_rejects_owner() {
        let mut env = Env::new();
        assert_eq!(
            env.call(OWNER, "set_agent", &OWNER).err(),
            Some(Error::AgentIsOwner)
        );
        assert_eq!(env.view().agent, AGENT);
    }
}

mod withdraw {
    use super::*;

    #[test]
    fn inv9_withdraw_pays_the_owner_only() {
        let mut env = Env::new();
        let result = env
            .call(OWNER, "withdraw", &ccd(30))
            .expect("owner withdraws");
        let transfers: Vec<_> = result.account_transfers().collect();
        assert_eq!(transfers, vec![(env.vault, ccd(30), OWNER)]);
        assert_eq!(env.vault_balance(), ccd(70));
    }

    #[test]
    fn withdraw_works_while_paused() {
        let mut env = Env::new();
        env.call(OWNER, "set_paused", &true).expect("owner pauses");
        env.call(OWNER, "withdraw", &FUNDING)
            .expect("owner withdraws everything");
        assert_eq!(env.vault_balance(), Amount::zero());
    }

    #[test]
    fn withdraw_rejects_zero_and_more_than_balance() {
        let mut env = Env::new();
        assert_eq!(
            env.call(OWNER, "withdraw", &Amount::zero()).err(),
            Some(Error::ZeroAmount)
        );
        assert_eq!(
            env.call(OWNER, "withdraw", &ccd(101)).err(),
            Some(Error::InsufficientFunds)
        );
        assert_eq!(env.vault_balance(), FUNDING);
    }
}

mod allowlist {
    use super::*;

    #[test]
    fn owner_adds_a_registry_checked_provider() {
        let mut env = Env::new();
        assert_eq!(env.provider_card(AGENT_1), Some(CARD_1));
        let result = env
            .add_provider(AGENT_2, CARD_2)
            .expect("owner adds agent 2");
        assert_eq!(
            vault_events(&env, &result),
            vec![Event::ProviderAdded(ProviderAddedEvent {
                token_id: AGENT_2,
                card_hash: CARD_2,
                wallet: NEW_WALLET,
            })]
        );
        assert_eq!(env.provider_card(AGENT_2), Some(CARD_2));
    }

    #[test]
    fn add_rejects_revoked_agent() {
        let mut env = Env::new();
        env.set_record(&agent_record(
            AGENT_2,
            AgentStatus::Revoked,
            Some(CARD_2),
            Some(NEW_WALLET),
        ));
        assert_eq!(
            env.add_provider(AGENT_2, CARD_2).err(),
            Some(Error::ProviderNotActive)
        );
        assert_eq!(env.provider_card(AGENT_2), None);
    }

    #[test]
    fn add_rejects_wrong_card_hash() {
        let mut env = Env::new();
        assert_eq!(
            env.add_provider(AGENT_2, CARD_1).err(),
            Some(Error::CardHashMismatch)
        );
        env.set_record(&agent_record(
            AGENT_2,
            AgentStatus::Active,
            None,
            Some(NEW_WALLET),
        ));
        assert_eq!(
            env.add_provider(AGENT_2, CARD_2).err(),
            Some(Error::CardHashMismatch),
            "a record without a card hash never matches"
        );
    }

    #[test]
    fn add_rejects_agent_without_wallet() {
        let mut env = Env::new();
        env.set_record(&agent_record(
            AGENT_2,
            AgentStatus::Active,
            Some(CARD_2),
            None,
        ));
        assert_eq!(
            env.add_provider(AGENT_2, CARD_2).err(),
            Some(Error::NoAgentWallet)
        );
    }

    #[test]
    fn add_rejects_unknown_token() {
        let mut env = Env::new();
        assert_eq!(
            env.add_provider(99, CARD_2).err(),
            Some(Error::RegistryQueryFailed)
        );
    }

    #[test]
    fn registry_record_with_external_reference_is_read() {
        let mut env = Env::new();
        let mut record = active(3, CARD_2, NEW_WALLET);
        record.external_reference = Some(ExternalReference {
            contract_address: ContractAddress::new(42, 0),
            kind: ExternalRefKind::Cis8(ExternalKeyId {
                namespace: "eip155:1".to_string(),
                key_type: "ed25519".to_string(),
                public_key: vec![0x02; 32],
            }),
        });
        env.set_record(&record);
        env.add_provider(3, CARD_2)
            .expect("fields after the external reference are read correctly");
    }

    #[test]
    fn owner_removes_provider() {
        let mut env = Env::new();
        let result = env
            .call(OWNER, "remove_provider", &AGENT_1)
            .expect("owner removes agent 1");
        assert_eq!(
            vault_events(&env, &result),
            vec![Event::ProviderRemoved(AGENT_1)]
        );
        assert_eq!(env.provider_card(AGENT_1), None);
        assert_eq!(
            env.call(OWNER, "remove_provider", &AGENT_1).err(),
            Some(Error::ProviderNotAllowed)
        );
    }
}

mod pay {
    use super::*;

    #[test]
    fn inv2_only_the_agent_can_pay() {
        let mut env = Env::new();
        for sender in [OWNER, OUTSIDER, NEW_AGENT] {
            assert_eq!(env.pay(sender, 0, ccd(1), 1).err(), Some(Error::NotAgent));
        }
        assert_eq!(env.balance_of(PROVIDER), ACCOUNT_BALANCE);
    }

    #[test]
    fn agent_pays_the_provider_wallet() {
        let mut env = Env::new();
        let result = env.pay(AGENT, 0, ccd(3), 1).expect("agent pays");
        let transfers: Vec<_> = result.account_transfers().collect();
        assert_eq!(transfers, vec![(env.vault, ccd(3), PROVIDER)]);
        assert_eq!(env.balance_of(PROVIDER), ACCOUNT_BALANCE + ccd(3));
        assert_eq!(env.vault_balance(), ccd(97));
        let view = env.view();
        assert_eq!(view.next_nonce, 1);
        assert_eq!(view.spent_today, ccd(3));
    }

    #[test]
    fn zero_amount_is_rejected() {
        let mut env = Env::new();
        assert_eq!(
            env.pay(AGENT, 0, Amount::zero(), 1).err(),
            Some(Error::ZeroAmount)
        );
    }

    #[test]
    fn inv3_per_tx_cap_boundary() {
        let mut env = Env::new();
        env.pay(AGENT, 0, PER_TX_CAP, 1)
            .expect("exactly the cap is allowed");
        let over = Amount::from_micro_ccd(PER_TX_CAP.micro_ccd + 1);
        assert_eq!(
            env.pay(AGENT, 1, over, 2).err(),
            Some(Error::ExceedsPerTxCap)
        );
    }

    #[test]
    fn inv4_daily_cap_stops_then_resets_at_utc_midnight() {
        let mut env = Env::new();
        env.pay(AGENT, 0, ccd(5), 1).expect("first payment");
        env.pay(AGENT, 1, ccd(5), 2)
            .expect("second payment reaches the cap");
        assert_eq!(
            env.pay(AGENT, 2, Amount::from_micro_ccd(1), 3).err(),
            Some(Error::ExceedsDailyCap)
        );

        env.set_time((START_DAY + 1) * DAY_MILLIS);
        let view = env.view();
        assert_eq!(view.current_day, START_DAY + 1);
        assert_eq!(view.spent_today, Amount::zero());
        env.pay(AGENT, 2, ccd(5), 3)
            .expect("new UTC day, new allowance");
        assert_eq!(env.view().spent_today, ccd(5));
    }

    #[test]
    fn inv4_midnight_edge_allows_two_caps_within_a_millisecond() {
        // Documented edge of the fixed UTC-day window (THREAT_MODEL.md).
        let mut env = Env::new();
        let midnight = (START_DAY + 1) * DAY_MILLIS;
        env.set_time(midnight - 1);
        env.pay(AGENT, 0, ccd(5), 1).expect("23:59:59.999");
        env.pay(AGENT, 1, ccd(5), 2)
            .expect("23:59:59.999, cap reached");
        env.set_time(midnight);
        env.pay(AGENT, 2, ccd(5), 3).expect("00:00:00.000");
        env.pay(AGENT, 3, ccd(5), 4)
            .expect("00:00:00.000, cap reached");
        assert_eq!(
            env.balance_of(PROVIDER),
            ACCOUNT_BALANCE + DAILY_CAP + DAILY_CAP
        );
    }

    #[test]
    fn inv5_pause_blocks_pay_until_unpaused() {
        let mut env = Env::new();
        env.call(OWNER, "set_paused", &true).expect("owner pauses");
        assert_eq!(env.pay(AGENT, 0, ccd(1), 1).err(), Some(Error::Paused));
        env.call(OWNER, "set_paused", &false)
            .expect("owner unpauses");
        env.pay(AGENT, 0, ccd(1), 1)
            .expect("agent pays after unpause");
    }

    #[test]
    fn inv6_nonce_must_be_the_next_in_sequence() {
        let mut env = Env::new();
        assert_eq!(
            env.pay(AGENT, 1, ccd(1), 1).err(),
            Some(Error::InvalidNonce)
        );
        env.pay(AGENT, 0, ccd(1), 1).expect("nonce 0");
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 2).err(),
            Some(Error::InvalidNonce),
            "a used nonce cannot be replayed"
        );
        env.pay(AGENT, 1, ccd(1), 2).expect("nonce 1");
    }

    #[test]
    fn inv6_invoice_cannot_be_paid_twice() {
        let mut env = Env::new();
        env.pay(AGENT, 0, ccd(1), 7)
            .expect("first payment of invoice 7");
        assert_eq!(
            env.pay(AGENT, 1, ccd(1), 7).err(),
            Some(Error::InvoiceAlreadyPaid)
        );
    }

    #[test]
    fn inv7_unlisted_provider_is_refused() {
        let mut env = Env::new();
        assert_eq!(
            env.pay_to(AGENT, AGENT_2, 0, ccd(1), 1).err(),
            Some(Error::ProviderNotAllowed),
            "active in the registry is not enough; the owner must allowlist it"
        );
    }

    #[test]
    fn inv7_provider_revoked_after_listing_is_refused() {
        let mut env = Env::new();
        env.set_record(&agent_record(
            AGENT_1,
            AgentStatus::Revoked,
            Some(CARD_1),
            Some(PROVIDER),
        ));
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 1).err(),
            Some(Error::ProviderNotActive)
        );
    }

    #[test]
    fn inv7_card_changed_after_listing_is_refused_until_re_added() {
        let mut env = Env::new();
        env.set_record(&active(AGENT_1, CARD_2, PROVIDER));
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 1).err(),
            Some(Error::CardHashMismatch)
        );
        env.add_provider(AGENT_1, CARD_2)
            .expect("owner approves the new card");
        env.pay(AGENT, 0, ccd(1), 1)
            .expect("payment works with the approved card");
    }

    #[test]
    fn inv7_removed_provider_is_refused() {
        let mut env = Env::new();
        env.call(OWNER, "remove_provider", &AGENT_1)
            .expect("owner removes agent 1");
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 1).err(),
            Some(Error::ProviderNotAllowed)
        );
    }

    #[test]
    fn inv11_wallet_removed_in_registry_is_refused() {
        let mut env = Env::new();
        env.set_record(&agent_record(
            AGENT_1,
            AgentStatus::Active,
            Some(CARD_1),
            None,
        ));
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 1).err(),
            Some(Error::NoAgentWallet)
        );
    }

    #[test]
    fn inv11_payment_follows_the_registry_wallet() {
        let mut env = Env::new();
        env.set_record(&active(AGENT_1, CARD_1, NEW_WALLET));
        let result = env.pay(AGENT, 0, ccd(2), 1).expect("agent pays");
        let transfers: Vec<_> = result.account_transfers().collect();
        assert_eq!(transfers, vec![(env.vault, ccd(2), NEW_WALLET)]);
        assert_eq!(env.balance_of(PROVIDER), ACCOUNT_BALANCE);
    }

    #[test]
    fn inv8_rejected_pay_changes_nothing() {
        let mut env = Env::new();
        let before = env.view();
        let provider_before = env.balance_of(PROVIDER);

        assert_eq!(
            env.pay(AGENT, 0, ccd(6), 1).err(),
            Some(Error::ExceedsPerTxCap)
        );
        assert_eq!(
            env.pay(AGENT, 5, ccd(1), 1).err(),
            Some(Error::InvalidNonce)
        );
        env.call(OWNER, "set_paused", &true).expect("owner pauses");
        assert_eq!(env.pay(AGENT, 0, ccd(1), 1).err(), Some(Error::Paused));
        env.call(OWNER, "set_paused", &false)
            .expect("owner unpauses");
        env.set_record(&active(AGENT_1, CARD_2, PROVIDER));
        assert_eq!(
            env.pay(AGENT, 0, ccd(1), 1).err(),
            Some(Error::CardHashMismatch)
        );
        env.set_record(&active(AGENT_1, CARD_1, PROVIDER));

        assert_eq!(env.view(), before);
        assert_eq!(env.balance_of(PROVIDER), provider_before);
        env.pay(AGENT, 0, ccd(1), 1)
            .expect("nonce 0 and invoice 1 are still unused");
    }

    #[test]
    fn insufficient_funds_is_rejected() {
        let mut env = Env::new();
        env.call(OWNER, "withdraw", &ccd(98))
            .expect("owner withdraws");
        assert_eq!(
            env.pay(AGENT, 0, ccd(3), 1).err(),
            Some(Error::InsufficientFunds)
        );
    }

    #[test]
    fn rotated_agent_replaces_the_old_one() {
        let mut env = Env::new();
        env.call(OWNER, "set_agent", &NEW_AGENT)
            .expect("owner rotates agent");
        assert_eq!(env.pay(AGENT, 0, ccd(1), 1).err(), Some(Error::NotAgent));
        env.pay(NEW_AGENT, 0, ccd(1), 1).expect("new agent pays");
    }

    #[test]
    fn lowering_caps_below_todays_spend_blocks_the_rest_of_the_day() {
        let mut env = Env::new();
        env.pay(AGENT, 0, ccd(5), 1).expect("spend 5 today");
        let caps = CapsParams {
            per_tx_cap: ccd(2),
            daily_cap: ccd(4),
        };
        env.call(OWNER, "set_caps", &caps)
            .expect("owner lowers caps");
        assert_eq!(
            env.pay(AGENT, 1, ccd(1), 2).err(),
            Some(Error::ExceedsDailyCap)
        );

        env.set_time((START_DAY + 1) * DAY_MILLIS);
        env.pay(AGENT, 1, ccd(2), 2)
            .expect("next day under the new caps");
    }
}

mod receipts {
    use super::*;

    #[test]
    fn inv8_first_receipt_starts_the_chain() {
        let mut env = Env::new();
        let result = env.pay(AGENT, 0, ccd(3), 9).expect("agent pays");
        let receipt = receipt_of(&env, &result);
        let body = &receipt.body;
        assert_eq!(body.vault, env.vault);
        assert_eq!(body.nonce, 0);
        assert_eq!(body.prev_hash, [0u8; 32]);
        assert_eq!(body.timestamp.timestamp_millis(), START_MILLIS);
        assert_eq!(body.agent, AGENT);
        assert_eq!(body.provider, AGENT_1);
        assert_eq!(body.card_hash, CARD_1);
        assert_eq!(body.payee, PROVIDER);
        assert_eq!(body.amount, ccd(3));
        assert_eq!(body.invoice_hash, invoice(9));
        assert_eq!(receipt.hash, sha256(&to_bytes(body)));
        assert_eq!(env.view().receipt_head, receipt.hash);
    }

    #[test]
    fn inv8_receipts_link_to_the_previous_one() {
        let mut env = Env::new();
        let first = env.pay(AGENT, 0, ccd(1), 1).expect("first payment");
        let first = receipt_of(&env, &first);
        env.set_time(START_MILLIS + 60_000);
        let second = env.pay(AGENT, 1, ccd(2), 2).expect("second payment");
        let second = receipt_of(&env, &second);
        assert_eq!(second.body.nonce, 1);
        assert_eq!(second.body.prev_hash, first.hash);
        assert_eq!(second.hash, sha256(&to_bytes(&second.body)));
        assert_ne!(second.hash, first.hash);
        assert_eq!(env.view().receipt_head, second.hash);
    }

    #[test]
    fn receipt_event_layout_is_tag_body_hash() {
        // The 3b verifier hashes the body bytes exactly as logged.
        let mut env = Env::new();
        let result = env.pay(AGENT, 0, ccd(1), 1).expect("agent pays");
        let raw = raw_vault_events(&env, &result);
        assert_eq!(raw.len(), 1);
        let bytes = &raw[0];
        assert_eq!(bytes.len(), 1 + 208 + 32);
        assert_eq!(bytes[0], 8, "Receipt is variant 8");
        assert_eq!(sha256(&bytes[1..209]), bytes[209..241]);
    }

    #[test]
    fn inv8_rejected_pay_leaves_the_head_unchanged() {
        let mut env = Env::new();
        env.pay(AGENT, 0, ccd(1), 1).expect("first payment");
        let head = env.view().receipt_head;
        assert_eq!(
            env.pay(AGENT, 1, ccd(6), 2).err(),
            Some(Error::ExceedsPerTxCap)
        );
        assert_eq!(env.view().receipt_head, head);
    }
}

mod events {
    use super::*;

    #[test]
    fn owner_actions_log_their_events() {
        let mut env = Env::new();
        let caps = CapsParams {
            per_tx_cap: ccd(2),
            daily_cap: ccd(4),
        };
        let cases: Vec<(ContractInvokeSuccess, Event)> = vec![
            (
                env.call_with(OWNER, "deposit", &(), ccd(1))
                    .expect("deposit"),
                Event::Deposited(ccd(1)),
            ),
            (
                env.call(OWNER, "withdraw", &ccd(2)).expect("withdraw"),
                Event::Withdrawn(ccd(2)),
            ),
            (
                env.call(OWNER, "set_caps", &caps).expect("set_caps"),
                Event::CapsSet(caps.clone()),
            ),
            (
                env.call(OWNER, "set_agent", &NEW_AGENT).expect("set_agent"),
                Event::AgentSet(NEW_AGENT),
            ),
            (
                env.call(OWNER, "set_paused", &true).expect("set_paused"),
                Event::PausedSet(true),
            ),
        ];
        for (result, expected) in cases {
            assert_eq!(vault_events(&env, &result), vec![expected]);
        }
    }

    /// Off-chain readers decode events by their first byte, so tags must not
    /// shift when variants are added.
    #[test]
    fn event_tags_are_stable() {
        let receipt_body = guard_vault::ReceiptBody {
            vault: ContractAddress::new(0, 0),
            nonce: 0,
            prev_hash: [0; 32],
            timestamp: Timestamp::from_timestamp_millis(0),
            agent: AGENT,
            provider: 0,
            card_hash: [0; 32],
            payee: PROVIDER,
            amount: Amount::zero(),
            invoice_hash: [0; 32],
        };
        let expected = [
            (
                Event::Initialized(InitializedEvent {
                    owner: OWNER,
                    agent: AGENT,
                    per_tx_cap: ccd(1),
                    daily_cap: ccd(1),
                    registry: ContractAddress::new(0, 0),
                }),
                0u8,
            ),
            (Event::Deposited(ccd(1)), 1),
            (Event::Withdrawn(ccd(1)), 2),
            (
                Event::CapsSet(CapsParams {
                    per_tx_cap: ccd(1),
                    daily_cap: ccd(1),
                }),
                3,
            ),
            (Event::AgentSet(AGENT), 4),
            (Event::PausedSet(true), 5),
            (
                Event::ProviderAdded(ProviderAddedEvent {
                    token_id: 1,
                    card_hash: [0; 32],
                    wallet: PROVIDER,
                }),
                6,
            ),
            (Event::ProviderRemoved(1), 7),
            (
                Event::Receipt(ReceiptEvent {
                    body: receipt_body,
                    hash: [0; 32],
                }),
                8,
            ),
        ];
        for (event, tag) in expected {
            assert_eq!(to_bytes(&event)[0], tag, "{event:?}");
        }
    }
}
