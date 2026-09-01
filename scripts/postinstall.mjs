#!/usr/bin/env node

// Install the packaged skills for every agent the user already has, then report in prose.
// The CLI itself only ever emits one line of JSON, so the human summary lives here.
// A failure must never fail `npm install`: the CLI is still usable, and
// `context-tree install` can be run by hand afterwards.
//
// Only a direct global install writes to the home directory. Being a dependency of
// something else — a local `pnpm install`, or a global install of a package that depends
// on this one — must not silently modify the developer's agent configuration, so it just
// prints the command.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// A global install of some *other* package that depends on this one also sets
// npm_config_global, so the flag alone does not mean this package is the install target.
// Such a copy sits inside the owning package's node_modules, whereas a directly installed
// one sits in npm's own prefix, which is not a package.
function ownedByAnotherPackage() {
  for (let directory = packageRoot; ; ) {
    const parent = dirname(directory);
    if (parent === directory) return false;
    if (basename(directory) === "node_modules") return existsSync(join(parent, "package.json"));
    directory = parent;
  }
}

if (process.env.npm_config_global !== "true" || ownedByAnotherPackage()) {
  process.stdout.write("Context Tree: run `context-tree install` to add the skills to your agent.\n");
  process.exit(0);
}

const cli = join(packageRoot, "dist", "cli", "index.mjs");
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
