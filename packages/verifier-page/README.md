# Verifier page

A static page that runs the same receipt-chain checks as `claw-pay-verify`, in the browser. It does three things:
- recomputes every receipt hash and follows every link,
- replays the owner's rules against every payment,
- confirms that the chain ends at the head the contract reports.

**Testnet only. It holds no keys and only reads.**

## Use it

```bash
npm run serve:page
```

Then open http://127.0.0.1:8080. To use another port: `npm run serve:page -- 9000`. The server binds to 127.0.0.1 and serves only the page's own files.

**Offline.** Choose, drop or paste an events file from `claw-pay-export`, or press **Load the sample** (the golden events from the contract tests). Nothing goes over the network.

**Live from a node.** Fill in:
- the node's gRPC-web URL (`https://host:port`; plain http only for localhost),
- the vault (`index[,subindex]`),
- the vault's init block height,
- optionally, an end height.

The page then:
1. checks that the node's genesis block is **Concordium testnet's**, and refuses any other network,
2. reads the vault's **finalized** events block by block, with the view at the last block, using the same exporter as `claw-pay-export`,
3. verifies them,
4. offers the events file for download, so anyone can re-check it with `claw-pay-verify`.

Live mode trusts the node you name to report the chain honestly, as `claw-pay-export` does. Use a node you trust, compare two nodes, or cross-check on CCDExplorer. The node must allow gRPC-web requests from the page's origin (CORS). Check this for the endpoint you use.

## What it trusts and allows

| | |
|---|---|
| Keys | None. The page never signs anything. |
| Scripts | Only its own bundle: CSP `script-src 'self' 'wasm-unsafe-eval'`. `'wasm-unsafe-eval'` lets the web-sdk compile its bundled Rust bindings (WebAssembly); it does not allow JavaScript `eval`. |
| Network | Offline mode uses none. Live mode connects only to the node URL you type: CSP `connect-src` allows https, plus http on loopback. |
| Rendering | Data from files and nodes is shown as text only, never as HTML. |

## How it is built

| Path | What |
|---|---|
| `src/pipeline.ts` | `checkFile`, `exportLive` (guard first), and the input parsers. No DOM; tested in Node. |
| `src/view-model.ts` | Turns a report into display rows. Tested in Node. |
| `src/app.ts` | DOM wiring only. |
| `build.ts` | esbuild bundle of `src/app.ts` into `site/app.js`. Also copies the golden events as `site/sample-events.json`. |
| `serve.ts` | The local server: 127.0.0.1, a whitelist of files, and the CSP and `nosniff` headers. |
| `site/` | The page, **committed** so it can be served without building. |

After changing anything in `src/`, rebuild:

```bash
npm run build:page
```

The build is deterministic. `npm test` and CI both fail if `site/` doesn't match a fresh build.

Publishing the page anywhere (for example GitHub Pages) is Patrick's decision. Nothing here deploys it.

## Tests

```bash
npm test --workspace @claw-pay-concordium/verifier-page
```

All offline:
- **Pipeline:** the golden file verifies and a tampered one doesn't. A live export over an in-memory testnet verifies, and a non-testnet node is refused before any block is read.
- **URL rules.**
- **View model.**
- **Build:** deterministic, browser-only, under 3 MB, and matches `site/`.
- **Server:** loopback only, CSP header, and no file outside the whitelist.
