//! Integration tests for the GuardVault skeleton.
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

use concordium_smart_contract_testing::*;

/// Simulated owner account.
const OWNER: AccountAddress = AccountAddress([1u8; 32]);
/// Simulated account that is not the owner.
const OTHER: AccountAddress = AccountAddress([2u8; 32]);

const INITIAL_BALANCE: Amount = Amount::from_ccd(10_000);
const SIGNER: Signer = Signer::with_one_key();
const ENERGY: u64 = 10_000;

/// Path of the module built by `cargo concordium build`.
///
/// `cargo concordium test` exports the output path; plain `cargo test` falls
/// back to the default location inside this crate.
fn module_path() -> String {
    std::env::var("CARGO_CONCORDIUM_TEST_MODULE_OUTPUT_PATH").unwrap_or_else(|_| {
        concat!(env!("CARGO_MANIFEST_DIR"), "/concordium-out/module.wasm.v1").to_string()
    })
}

/// Create a chain with two funded accounts, deploy the module and initialize
/// a vault from `OWNER`.
fn setup() -> (Chain, ContractAddress) {
    let mut chain = Chain::new();
    chain.create_account(Account::new(OWNER, INITIAL_BALANCE));
    chain.create_account(Account::new(OTHER, INITIAL_BALANCE));

    let module =
        module_load_v1(module_path()).expect("module exists; run `cargo concordium build` first");
    let deployment = chain
        .module_deploy_v1(SIGNER, OWNER, module)
        .expect("module deploys");

    let init = chain
        .contract_init(
            SIGNER,
            OWNER,
            Energy::from(ENERGY),
            InitContractPayload {
                amount: Amount::zero(),
                mod_ref: deployment.module_reference,
                init_name: OwnedContractName::new_unchecked("init_guard_vault".to_string()),
                param: OwnedParameter::empty(),
            },
        )
        .expect("init succeeds");

    (chain, init.contract_address)
}

/// Call the read-only `owner` view as `invoker`.
fn view_owner(chain: &Chain, contract: ContractAddress, invoker: AccountAddress) -> AccountAddress {
    chain
        .contract_invoke(
            invoker,
            Address::Account(invoker),
            Energy::from(ENERGY),
            UpdateContractPayload {
                amount: Amount::zero(),
                address: contract,
                receive_name: OwnedReceiveName::new_unchecked("guard_vault.owner".to_string()),
                message: OwnedParameter::empty(),
            },
        )
        .expect("owner view succeeds")
        .parse_return_value()
        .expect("return value is an AccountAddress")
}

#[test]
fn init_records_initializer_as_owner() {
    let (chain, contract) = setup();
    assert_eq!(view_owner(&chain, contract, OWNER), OWNER);
}

#[test]
fn owner_view_is_the_same_for_any_caller() {
    let (chain, contract) = setup();
    assert_eq!(view_owner(&chain, contract, OTHER), OWNER);
    assert_eq!(view_owner(&chain, contract, OWNER), OWNER);
}
