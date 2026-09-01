#!/usr/bin/env node

// Install the packaged skills for every agent the user already has, then report in prose.
// The CLI itself only ever emits one line of JSON, so the human summary lives here.
// A failure must never fail `npm install`: the CLI is still usable, and
// `context-tree install` can be run by hand afterwards.
//
// Only a global install writes to the home directory. Adding this package as a local
// dependency — including this repository's own `pnpm install` — must not silently
// modify the developer's agent configuration, so it just prints the command.

import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

if (process.env.npm_config_global !== "true") {
  process.stdout.write("Context Tree: run `context-tree install` to add the skills to your agent.\n");
  process.exit(0);
}

const cli = resolve(dirname(fileURLToPath(import.meta.url)), "..", "dist", "cli", "index.mjs");
const result = spawnSync(process.execPath, [cli, "install"], { encoding: "utf8" });

if (result.error !== undefined || result.status !== 0) {
  process.stdout.write("Context Tree: run `context-tree install` to add the skills to your agent.\n");
  process.exit(0);
}

let payload;
try {
  payload = JSON.parse(result.stdout);
} catch {
  process.exit(0);
}

const installed = Array.isArray(payload?.installed) ? payload.installed : [];
const skipped = Array.isArray(payload?.skipped) ? payload.skipped : [];

if (installed.length === 0) {
  process.stdout.write(
    "Context Tree: no agent directory found. Install Claude Code or Codex, then run `context-tree install`.\n",
  );
  process.exit(0);
}

for (const entry of installed) {
  const count = Array.isArray(entry?.skills) ? entry.skills.length : 0;
  process.stdout.write(`Context Tree: installed ${count} skills for ${entry?.host} in ${entry?.path}\n`);
}
for (const entry of skipped) {
  process.stdout.write(`Context Tree: skipped ${entry?.host} — ${entry?.reason}\n`);
}
process.stdout.write("Restart your agent to pick them up.\n");
