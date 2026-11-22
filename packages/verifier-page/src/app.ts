/**
 * The verifier page's DOM wiring. Everything the page checks goes through
 * pipeline.ts; this file only reads inputs and renders results, using
 * textContent (never innerHTML) for anything that came from a file or a node.
 */

import { ConcordiumGRPCWebClient } from "@concordium/web-sdk/grpc";

import { InputError, checkFile, exportLive, parseHeight, parseNodeUrl, parseVault, type Checked } from "./pipeline.ts";
import { toViewModel } from "./view-model.ts";

/** The element with `id`, checked to be of the expected kind. */
function element<T extends HTMLElement>(id: string, kind: { new (): T; prototype: T }): T {
  const found = document.getElementById(id);
  if (!(found instanceof kind)) {
    throw new Error(`missing #${id}`);
  }
  return found;
}

const status = element("status", HTMLElement);
const summary = element("summary", HTMLElement);
const receiptsBody = element("receipts-body", HTMLTableSectionElement);
const receiptsSection = element("receipts", HTMLElement);
const issuesList = element("issues", HTMLUListElement);
const download = element("download", HTMLAnchorElement);
const progress = element("progress", HTMLElement);
let downloadUrl: string | null = null;

function message(error: unknown): string {
  if (error instanceof InputError) {
    return error.message;
  }
  return error instanceof Error ? error.message : String(error);
}

function showError(text: string): void {
  status.textContent = "Could not check";
  status.className = "status bad";
  summary.textContent = text;
  receiptsBody.replaceChildren();
  receiptsSection.hidden = true;
  issuesList.replaceChildren();
}

function show(checked: Checked, eventsJson: string | null): void {
  const view = toViewModel(checked.file, checked.report);
  status.textContent = view.headline;
  status.className = view.ok ? "status ok" : "status bad";
  summary.textContent = view.summary;
  receiptsBody.replaceChildren(
    ...view.receipts.map((row) => {
      const tr = document.createElement("tr");
      for (const value of [row.nonce, row.time, row.amount, row.provider, row.payee, row.hash]) {
        const td = document.createElement("td");
        td.textContent = value;
        tr.append(td);
      }
      const payeeCell = tr.children[4];
      if (payeeCell instanceof HTMLTableCellElement) {
        payeeCell.title = row.payeeFull;
      }
      return tr;
    }),
  );
  receiptsSection.hidden = view.receipts.length === 0;
  issuesList.replaceChildren(
    ...view.issues.map((text) => {
      const li = document.createElement("li");
      li.textContent = text;
      return li;
    }),
  );
  if (downloadUrl !== null) {
    URL.revokeObjectURL(downloadUrl);
    downloadUrl = null;
  }
  download.hidden = eventsJson === null;
  if (eventsJson !== null) {
    downloadUrl = URL.createObjectURL(new Blob([eventsJson], { type: "application/json" }));
    download.href = downloadUrl;
  }
}

function checkText(text: string): void {
  try {
    show(checkFile(text), null);
  } catch (error) {
    showError(message(error));
  }
}

// Offline: file, drop, paste, sample.
element("file", HTMLInputElement).addEventListener("change", (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file !== undefined) {
    void file.text().then(checkText);
  }
});

const dropZone = element("drop", HTMLElement);
dropZone.addEventListener("dragover", (event) => {
  event.preventDefault();
  dropZone.classList.add("over");
});
dropZone.addEventListener("dragleave", () => {
  dropZone.classList.remove("over");
});
dropZone.addEventListener("drop", (event) => {
  event.preventDefault();
  dropZone.classList.remove("over");
  const file = event.dataTransfer?.files[0];
  if (file !== undefined) {
    void file.text().then(checkText);
  }
});

element("check-paste", HTMLButtonElement).addEventListener("click", () => {
  checkText(element("paste", HTMLTextAreaElement).value);
});

element("sample", HTMLButtonElement).addEventListener("click", () => {
  void fetch("sample-events.json")
    .then((response) => response.text())
    .then(checkText, (error: unknown) => {
      showError(message(error));
    });
});

// Live: read the vault's finalized events from a testnet node.
const liveButton = element("live-check", HTMLButtonElement);
element("live", HTMLFormElement).addEventListener("submit", (event) => {
  event.preventDefault();
  let options;
  try {
    const node = parseNodeUrl(element("node", HTMLInputElement).value);
    const vault = parseVault(element("vault", HTMLInputElement).value);
    const fromHeight = parseHeight(element("from", HTMLInputElement).value, "From height") ?? 0n;
    const toHeight = parseHeight(element("to", HTMLInputElement).value, "To height", true);
    options = { node, vault, fromHeight, toHeight };
  } catch (error) {
    showError(message(error));
    return;
  }
  liveButton.disabled = true;
  progress.textContent = "Checking the node is on testnet…";
  const client = new ConcordiumGRPCWebClient(options.node.address, options.node.port);
  exportLive({
    client,
    vault: options.vault,
    fromHeight: options.fromHeight,
    ...(options.toHeight === undefined ? {} : { toHeight: options.toHeight }),
    onBlock: (height) => {
      progress.textContent = `Read block ${String(height)}…`;
    },
  })
    .then(
      (result) => {
        progress.textContent = `Read finalized blocks ${String(options.fromHeight)}–${String(result.toHeight)}; view at block ${result.blockHash.slice(0, 16)}….`;
        show(result, `${JSON.stringify(result.json, null, 2)}\n`);
      },
      (error: unknown) => {
        progress.textContent = "";
        showError(message(error));
      },
    )
    .finally(() => {
      liveButton.disabled = false;
    });
});
