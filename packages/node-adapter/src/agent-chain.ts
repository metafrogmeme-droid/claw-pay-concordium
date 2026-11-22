/**
 * agent-client's `AgentChain` on a Concordium node: the vault's next nonce
 * and today's on-chain spend (from `view`), and the agent's next sequence
 * number.
 */

import type { AccountAddress, ContractAddress } from "@concordium/web-sdk";
import type { AgentChain } from "@claw-pay-concordium/agent-client";

import type { NodeClient } from "./testnet-guard.ts";
import { readVaultView } from "./vault-view.ts";

export function nodeAgentChain(
  client: Pick<NodeClient, "invokeContract" | "getNextAccountNonce">,
  vault: ContractAddress.Type,
  agent: AccountAddress.Type,
): Required<AgentChain> {
  return {
    vaultNonce: async () => (await readVaultView(client, vault)).nextNonce,
    accountSequence: async () => (await client.getNextAccountNonce(agent)).nonce.value,
    vaultSpentToday: async () => {
      const view = await readVaultView(client, vault);
      return { day: Number(view.currentDay), spent: view.spentToday };
    },
  };
}
