#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

let input;
try {
  input = JSON.parse(
    await new Promise((resolve) => {
      let source = "";
      process.stdin.setEncoding("utf8");
      process.stdin.on("data", (chunk) => {
        source += chunk;
      });
      process.stdin.on("end", () => resolve(source));
    }),
  );
} catch {
  process.exit(0);
}

if (typeof input !== "object" || input === null || Array.isArray(input)) {
  process.exit(0);
}
if (input.hook_event_name !== "SessionStart" && input.hook_event_name !== "SubagentStart") process.exit(0);

const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
const packagedCli = pluginRoot === undefined ? undefined : join(pluginRoot, "dist", "cli", "index.mjs");
if (packagedCli === undefined || !existsSync(packagedCli)) {
  process.exit(0);
}
const resolved = spawnSync(process.execPath, [packagedCli, "resolve"], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
let payload;
try {
  payload = JSON.parse(resolved.stdout);
} catch {
  process.exit(0);
}

if (resolved.status !== 0) process.exit(0);

const tree = payload?.tree;
if (typeof tree?.path !== "string") process.exit(0);
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      additionalContext: `Context Tree connected at ${tree.path}`,
      hookEventName: input.hook_event_name,
    },
  }),
);
