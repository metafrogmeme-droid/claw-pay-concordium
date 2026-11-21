#!/usr/bin/env node
/**
 * claw-pay-verify <events.json>
 *
 * Exit codes: 0 verified, 1 verification failed, 2 usage error or unreadable
 * input.
 */

import { readFileSync, realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { parseEventsFile } from "./events-file.ts";
import { formatReport } from "./report.ts";
import { verify } from "./verify.ts";

export const USAGE = "usage: claw-pay-verify <events.json>";

export function run(
  args: readonly string[],
  out: (line: string) => void,
  err: (line: string) => void,
): number {
  const [path, ...rest] = args;
  if (path === undefined || rest.length > 0) {
    err(USAGE);
    return 2;
  }
  let file;
  try {
    file = parseEventsFile(JSON.parse(readFileSync(path, "utf8")) as unknown);
  } catch (error) {
    err(`cannot read ${path}: ${error instanceof Error ? error.message : String(error)}`);
    return 2;
  }
  const report = verify(file);
  for (const line of formatReport(file, report)) {
    out(line);
  }
  return report.ok ? 0 : 1;
}

function isMain(): boolean {
  const entry = process.argv[1];
  if (entry === undefined) {
    return false;
  }
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

if (isMain()) {
  process.exitCode = run(
    process.argv.slice(2),
    (line) => {
      console.log(line);
    },
    (line) => {
      console.error(line);
    },
  );
}
