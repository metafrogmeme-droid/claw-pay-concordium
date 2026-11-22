/**
 * Build the verifier page: bundle src/app.ts (with the web-sdk's gRPC-web
 * client) into site/app.js, and copy the golden events file as the sample.
 * The output is committed; CI rebuilds it and fails if it differs.
 *
 *   npm run build:page
 */

import { copyFileSync, mkdirSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { build } from "esbuild";

const HERE = fileURLToPath(new URL(".", import.meta.url));
export const SITE = join(HERE, "site");
const FIXTURE = join(HERE, "..", "..", "fixtures", "vault-events.v1.json");

export async function buildPage(outdir: string = SITE): Promise<void> {
  mkdirSync(outdir, { recursive: true });
  await build({
    entryPoints: [join(HERE, "src", "app.ts")],
    outfile: join(outdir, "app.js"),
    bundle: true,
    format: "esm",
    platform: "browser",
    target: "es2022",
    minify: true,
    treeShaking: true,
    legalComments: "eof",
    charset: "utf8",
    sourcemap: false,
    logLevel: "warning",
  });
  copyFileSync(FIXTURE, join(outdir, "sample-events.json"));
}

function isMain(): boolean {
  const entry = process.argv[1];
  try {
    return entry !== undefined && realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  buildPage().then(
    () => {
      console.log(`built ${SITE}`);
    },
    (error: unknown) => {
      console.error(error);
      process.exitCode = 1;
    },
  );
}
