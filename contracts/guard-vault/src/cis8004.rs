//! CIS-8004 Agent Registry wire types: only what the vault needs to call
//! `agentOf` and read the reply.
//!
//! Source: `source/CIS/cis-8004.rst` and `source/CIS/cis-8.rst` in
//! `Concordium/concordium-update-proposals`. Strings and byte strings carry a
//! 4-byte little-endian length, and optional fields a 1-byte tag (0 absent,
//! 1 present). That is the standard Concordium serialization, so the derives
//! below match the spec. `AgentTokenId` is the exception and has a manual
//! impl.

use concordium_std::*;

/// Entrypoint that returns an agent's record.
pub const AGENT_OF: &str = "agentOf";

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

/// CIS-8 `ExternalKeyId ::= (namespace: String) (key_type: String) (public_key: Bytestring)`.
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

/// The `AgentView` record returned by `agentOf`. `metadata_hash` is the
/// SHA-256 of the agent card; `agent_wallet` is the agent's payment address.
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

#[cfg(test)]
mod tests {
    use super::*;

    fn push_u32(out: &mut Vec<u8>, n: u32) {
        out.extend_from_slice(&n.to_le_bytes());
    }

    fn push_u64(out: &mut Vec<u8>, n: u64) {
        out.extend_from_slice(&n.to_le_bytes());
    }

    fn push_string(out: &mut Vec<u8>, s: &str) {
        push_u32(out, s.len() as u32);
        out.extend_from_slice(s.as_bytes());
    }

    #[test]
    fn token_id_is_length_prefixed_u64() {
        let bytes = to_bytes(&AgentTokenId(10));
        assert_eq!(bytes, [8, 10, 0, 0, 0, 0, 0, 0, 0]);
        assert_eq!(from_bytes::<AgentTokenId>(&bytes), Ok(AgentTokenId(10)));
        assert!(from_bytes::<AgentTokenId>(&[4, 10, 0, 0, 0]).is_err());
    }

    /// An active agent with a card hash, an external reference and a wallet,
    /// written byte by byte from the spec's `AgentView` grammar.
    #[test]
    fn decodes_active_agent_with_external_reference() {
        let mut b = Vec::new();
        b.push(8); // token_id
        push_u64(&mut b, 10);
        b.extend_from_slice(&[0x11; 32]); // owner_account
        b.push(0); // agent_uri: absent
        b.push(1); // metadata_hash: present
        b.extend_from_slice(&[0xAA; 32]);
        b.push(1); // external_reference: present
        push_u64(&mut b, 7); // contract index
        push_u64(&mut b, 0); // contract subindex
        b.push(0); // kind: Cis8
        push_string(&mut b, "eip155:1");
        push_string(&mut b, "ed25519");
        push_u32(&mut b, 32);
        b.extend_from_slice(&[0x22; 32]); // public_key
        b.push(1); // agent_wallet: present
        b.extend_from_slice(&[0x33; 32]);
        b.push(0); // status: Active
        push_u64(&mut b, 1_700_000_000_000); // registered_at
        b.push(0); // revoked_at: absent
        b.push(0); // revocation_reason: absent

        let view: AgentView = from_bytes(&b).expect("spec bytes parse");
        assert_eq!(view.token_id, AgentTokenId(10));
        assert_eq!(view.owner_account, AccountAddress([0x11; 32]));
        assert_eq!(view.agent_uri, None);
        assert_eq!(view.metadata_hash, Some([0xAA; 32]));
        assert_eq!(
            view.external_reference,
            Some(ExternalReference {
                contract_address: ContractAddress::new(7, 0),
                kind: ExternalRefKind::Cis8(ExternalKeyId {
                    namespace: "eip155:1".into(),
                    key_type: "ed25519".into(),
                    public_key: [0x22; 32].to_vec(),
                }),
            })
        );
        assert_eq!(view.agent_wallet, Some(AccountAddress([0x33; 32])));
        assert_eq!(view.status, AgentStatus::Active);
        assert_eq!(view.registered_at.timestamp_millis(), 1_700_000_000_000);
        assert_eq!(to_bytes(&view), b, "re-serializing gives the same bytes");
    }

    #[test]
    fn decodes_revoked_agent_without_wallet() {
        let mut b = Vec::new();
        b.push(8);
        push_u64(&mut b, 3);
        b.extend_from_slice(&[0x44; 32]);
        b.push(1); // agent_uri: present
        push_string(&mut b, "https://agent.example/card.json");
        b.push(0); // metadata_hash: absent
        b.push(0); // external_reference: absent
        b.push(0); // agent_wallet: absent
        b.push(1); // status: Revoked
        push_u64(&mut b, 1_700_000_000_000);
        b.push(1); // revoked_at: present
        push_u64(&mut b, 1_700_000_100_000);
        b.push(1); // revocation_reason: present
        push_string(&mut b, "key leaked");

        let view: AgentView = from_bytes(&b).expect("spec bytes parse");
        assert_eq!(view.status, AgentStatus::Revoked);
        assert_eq!(view.agent_wallet, None);
        assert_eq!(view.metadata_hash, None);
        assert_eq!(view.revocation_reason.as_deref(), Some("key leaked"));
    }
}
