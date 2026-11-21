//! Integration tests for GuardVault.
//!
//! They run against the compiled Wasm module on the simulated chain from
//! `concordium-smart-contract-testing`. No network, no real keys: the
//! accounts below are fixed byte arrays that exist only in the simulator.
//!
//! Build the module first, from `contracts/guard-vault`:
//!
//! ```text
//! cargo concordium build --out concordium-out/module.wasm.v1
//! ```
//!
//! Test names refer to the invariants in `THREAT_MODEL.md`.

use concordium_smart_contract_testing::*;
use concordium_std::Serial;
use guard_vault::{CapsParams, Error, InitParams, InvoiceHash, PayParams, VaultView};

const OWNER: AccountAddress = AccountAddress([1u8; 32]);
const AGENT: AccountAddress = AccountAddress([2u8; 32]);
const PROVIDER: AccountAddress = AccountAddress([3u8; 32]);
const OUTSIDER: AccountAddress = AccountAddress([4u8; 32]);
const NEW_AGENT: AccountAddress = AccountAddress([5u8; 32]);

const ACCOUNT_BALANCE: Amount = Amount::from_ccd(10_000);
const PER_TX_CAP: Amount = Amount::from_ccd(5);
const DAILY_CAP: Amount = Amount::from_ccd(10);
const FUNDING: Amount = Amount::from_ccd(100);

const SIGNER: Signer = Signer::with_one_key();
const ENERGY: u64 = 50_000;

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

/// Path of the module built by `cargo concordium build`.
///
/// `cargo concordium test` exports the output path; plain `cargo test` falls
/// back to the default location inside this crate.
fn module_path() -> String {
    std::env::var("CARGO_CONCORDIUM_TEST_MODULE_OUTPUT_PATH").unwrap_or_else(|_| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/concordium-out/module.wasm.v1").to_string()
    })
}

fn default_params() -> InitParams {
    InitParams {
        agent: AGENT,
        per_tx_cap: PER_TX_CAP,
        daily_cap: DAILY_CAP,
    }
}

/// A chain at `START_MILLIS` with five funded accounts and the module deployed.
fn new_chain() -> (Chain, ModuleReference) {
    let mut chain = Chain::builder()
        .block_time(Timestamp::from_timestamp_millis(START_MILLIS))
        .build()
        .expect("chain builds");
    for account in [OWNER, AGENT, PROVIDER, OUTSIDER, NEW_AGENT] {
        chain.create_account(Account::new(account, ACCOUNT_BALANCE));
    }
    let module =
        module_load_v1(module_path()).expect("module exists; run `cargo concordium build` first");
    let deployment = chain
        .module_deploy_v1(SIGNER, OWNER, module)
        .expect("module deploys");
    (chain, deployment.module_reference)
}

/// The reject code the contract uses for `error`.
fn reject_code(error: Error) -> i32 {
    concordium_std::Reject::from(error).error_code.get()
}

/// Initialize a vault from `sender`. An init rejection carries only the
/// reject code (no return value), so that is what the error holds.
fn init_vault(
    chain: &mut Chain,
    mod_ref: ModuleReference,
    sender: AccountAddress,
    params: &InitParams,
) -> Result<ContractAddress, i32> {
    chain
        .contract_init(
            SIGNER,
            sender,
            Energy::from(ENERGY),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref,
                init_name: OwnedContractName::new_unchecked("init_guard_vault".to_string()),
                param: OwnedParameter::from_serial(params).expect("parameter fits"),
            },
        )
        .map(|ok| ok.contract_address)
        .map_err(|err| match err.kind {
            ContractInitErrorKind::ExecutionError {
                error: InitExecutionError::Reject { reason, .. },
                ..
            } => reason,
            other => panic!("unexpected init failure: {other:?}"),
        })
}

/// A funded vault: OWNER is the owner, AGENT the agent, FUNDING deposited.
struct Env {
    chain: Chain,
    vault: ContractAddress,
}

impl Env {
    fn new() -> Self {
        let (mut chain, mod_ref) = new_chain();
        let vault =
            init_vault(&mut chain, mod_ref, OWNER, &default_params()).expect("init succeeds");
        let mut env = Env { chain, vault };
        env.call_with(OWNER, "deposit", &(), FUNDING)
            .expect("owner deposits");
        env
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

    fn pay(
        &mut self,
        sender: AccountAddress,
        nonce: u64,
        amount: Amount,
        invoice_id: u8,
    ) -> Result<ContractInvokeSuccess, Error> {
        let params = PayParams {
            provider: PROVIDER,
            amount,
            nonce,
            invoice_hash: invoice(invoice_id),
        };
        self.call(sender, "pay", &params)
    }

    fn view(&self) -> VaultView {
        self.chain
            .contract_invoke(
                OUTSIDER,
                Address::Account(OUTSIDER),
                Energy::from(ENERGY),
                UpdateContractPayload {
                    amount: Amount::zero(),
                    address: self.vault,
                    receive_name: OwnedReceiveName::new_unchecked("guard_vault.view".to_string()),
                    message: OwnedParameter::empty(),
                },
            )
            .expect("view succeeds")
            .parse_return_value()
            .expect("return value is a VaultView")
    }

    fn provider_balance(&self) -> Amount {
        self.chain
            .account_balance_available(PROVIDER)
            .expect("provider exists")
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
    ];
    for (error, code) in expected {
        assert_eq!(reject_code(error), code);
    }
}

mod init {
    use super::*;

    #[test]
    fn init_sets_owner_agent_and_caps() {
        let env = Env::new();
        assert_eq!(
            env.view(),
            VaultView {
                owner: OWNER,
                agent: AGENT,
                per_tx_cap: PER_TX_CAP,
                daily_cap: DAILY_CAP,
                paused: false,
                next_nonce: 0,
                current_day: START_DAY,
                spent_today: Amount::zero(),
                balance: FUNDING,
            }
        );
    }

    #[test]
    fn inv10_init_rejects_agent_equal_to_owner() {
        let (mut chain, mod_ref) = new_chain();
        let params = InitParams {
            agent: OWNER,
            ..default_params()
        };
        assert_eq!(
            init_vault(&mut chain, mod_ref, OWNER, &params),
            Err(reject_code(Error::AgentIsOwner))
        );
    }

    #[test]
    fn init_rejects_invalid_caps() {
        let (mut chain, mod_ref) = new_chain();
        let per_tx_above_daily = InitParams {
            per_tx_cap: ccd(11),
            ..default_params()
        };
        let zero_per_tx = InitParams {
            per_tx_cap: Amount::zero(),
            ..default_params()
        };
        for params in [per_tx_above_daily, zero_per_tx] {
            assert_eq!(
                init_vault(&mut chain, mod_ref, OWNER, &params),
                Err(reject_code(Error::InvalidCaps))
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
        }
        assert_eq!(env.view(), before);
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

mod pay {
    use super::*;

    #[test]
    fn inv2_only_the_agent_can_pay() {
        let mut env = Env::new();
        for sender in [OWNER, OUTSIDER, NEW_AGENT] {
            assert_eq!(env.pay(sender, 0, ccd(1), 1).err(), Some(Error::NotAgent));
        }
        assert_eq!(env.provider_balance(), ACCOUNT_BALANCE);
    }

    #[test]
    fn agent_pays_provider() {
        let mut env = Env::new();
        let result = env.pay(AGENT, 0, ccd(3), 1).expect("agent pays");
        let transfers: Vec<_> = result.account_transfers().collect();
        assert_eq!(transfers, vec![(env.vault, ccd(3), PROVIDER)]);
        assert_eq!(env.provider_balance(), ACCOUNT_BALANCE + ccd(3));
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
            env.provider_balance(),
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
    fn inv8_rejected_pay_changes_nothing() {
        let mut env = Env::new();
        let before = env.view();
        let provider_before = env.provider_balance();

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

        assert_eq!(env.view(), before);
        assert_eq!(env.provider_balance(), provider_before);
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
