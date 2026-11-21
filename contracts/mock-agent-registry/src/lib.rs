//! # Mock CIS-8004 Agent Registry: TEST ONLY, NEVER DEPLOY
//!
//! A stand-in for Concordium's Agent Registry (CIS-8004), used only by the
//! GuardVault integration tests on the simulated chain. It implements just
//! `agentOf` in the CIS-8004 wire format, plus an open `set_agent` setter so
//! tests can make agents active, revoked, re-carded or re-walleted.
//!
//! `set_agent` has no access control on purpose. Anyone could rewrite any
//! agent, which is exactly why this contract must never be deployed.
//!
//! The types below follow `source/CIS/cis-8004.rst` in
//! `Concordium/concordium-update-proposals`. They are written separately from
//! the vault's parser, so a mismatch between the two shows up in the tests.
#![no_std]

use concordium_std::*;

/// CIS-8004 `AgentNotFound`.
const AGENT_NOT_FOUND: i32 = -7200;

/// `AgentTokenId ::= (8: Byte) (id: Byte⁸)`, the CIS-2 `TokenIdU64` wire form.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct AgentTokenId(pub u64);

impl Serial for AgentTokenId {
    fn serial<W: Write>(&self, out: &mut W) -> Result<(), W::Err> {
        8u8.serial(out)?;
        self.0.serial(out)
    }
}

impl Deserial for AgentTokenId {
    fn deserial<R: Read>(source: &mut R) -> ParseResult<Self> {
        if u8::deserial(source)? != 8 {
            return Err(ParseError::default());
        }
        Ok(AgentTokenId(u64::deserial(source)?))
    }
}

/// `ExternalKeyId ::= (namespace: String) (key_type: String) (public_key: Bytestring)` (CIS-8).
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalKeyId {
    pub namespace: String,
    pub key_type: String,
    pub public_key: Vec<u8>,
}

/// `ExternalRefKind ::= (0: Byte) (key: ExternalKeyId)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub enum ExternalRefKind {
    Cis8(ExternalKeyId),
}

/// `ExternalReference ::= (contract_address: ContractAddress) (kind: ExternalRefKind)`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ExternalReference {
    pub contract_address: ContractAddress,
    pub kind: ExternalRefKind,
}

/// `AgentStatus ::= (0: Byte) // Active | (1: Byte) // Revoked`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
pub enum AgentStatus {
    Active,
    Revoked,
}

/// The CIS-8004 `AgentView` record returned by `agentOf`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct AgentView {
    pub token_id: AgentTokenId,
    pub owner_account: AccountAddress,
    pub agent_uri: Option<String>,
    pub metadata_hash: Option<[u8; 32]>,
    pub external_reference: Option<ExternalReference>,
    pub agent_wallet: Option<AccountAddress>,
    pub status: AgentStatus,
    pub registered_at: Timestamp,
    pub revoked_at: Option<Timestamp>,
    pub revocation_reason: Option<String>,
}

#[derive(Serial, DeserialWithState)]
#[concordium(state_parameter = "S")]
pub struct State<S = StateApi> {
    agents: StateMap<u64, AgentView, S>,
}

#[init(contract = "mock_agent_registry")]
fn init(_ctx: &InitContext, state_builder: &mut StateBuilder) -> InitResult<State> {
    Ok(State {
        agents: state_builder.new_map(),
    })
}

/// TEST ONLY: create or replace an agent record. No access control.
#[receive(contract = "mock_agent_registry", name = "set_agent", mutable)]
fn set_agent(ctx: &ReceiveContext, host: &mut Host<State>) -> ReceiveResult<()> {
    let view: AgentView = ctx.parameter_cursor().get()?;
    // Replacing an existing record is the point; the old one is dropped.
    let _previous = host.state_mut().agents.insert(view.token_id.0, view);
    Ok(())
}

/// CIS-8004 `agentOf`: return the `AgentView`, or reject with `AgentNotFound`.
#[receive(contract = "mock_agent_registry", name = "agentOf")]
fn agent_of(ctx: &ReceiveContext, host: &Host<State>) -> ReceiveResult<AgentView> {
    let token_id: AgentTokenId = ctx.parameter_cursor().get()?;
    match host.state().agents.get(&token_id.0) {
        Some(view) => Ok((*view).clone()),
        None => Err(Reject::new(AGENT_NOT_FOUND).unwrap_or_default()),
    }
}
