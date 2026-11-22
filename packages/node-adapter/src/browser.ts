/**
 * The browser-safe part of the node adapter: the testnet guard, the vault
 * view decoder, the trace collector and the finalized-events exporter. None
 * of these import Node-only modules, so they run with the web-sdk's
 * `ConcordiumGRPCWebClient` in a browser (the verifier page uses them).
 */

export { TESTNET_GENESIS_PREFIX, WrongNetworkError, assertTestnetNode } from "./testnet-guard.ts";
export type { NodeClient } from "./testnet-guard.ts";
export { VAULT_VIEW_LENGTH, VIEW_ENTRYPOINT, ViewError, decodeVaultView, readVaultView } from "./vault-view.ts";
export type { VaultView } from "./vault-view.ts";
export { UnknownEntryError, vaultEventsFromSummary, vaultEventsFromTrace } from "./trace.ts";
export { ExportError, exportVaultEvents } from "./exporter.ts";
export type { EventsFileJson, ExportClient, ExportOptions, ExportResult } from "./exporter.ts";
