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

if (typeof input !== "object" || input === null || Array.isArray(input) || typeof input.cwd !== "string") {
  process.exit(0);
}
if (input.hook_event_name !== "SessionStart" && input.hook_event_name !== "SubagentStart") process.exit(0);

const pluginRoot = process.env.PLUGIN_ROOT ?? process.env.CLAUDE_PLUGIN_ROOT;
const packagedCli = pluginRoot === undefined ? undefined : join(pluginRoot, "dist", "cli", "index.mjs");
if (packagedCli === undefined || !existsSync(packagedCli)) {
  process.stdout.write(JSON.stringify({ systemMessage: "Context Tree setup warning: packaged CLI is unavailable." }));
  process.exit(0);
}
const resolved = spawnSync(process.execPath, [packagedCli, "resolve", "--project-path", input.cwd], {
  encoding: "utf8",
  stdio: ["ignore", "pipe", "ignore"],
});
let payload;
try {
  payload = JSON.parse(resolved.stdout);
} catch {
  process.stdout.write(JSON.stringify({ systemMessage: "Context Tree setup warning: packaged CLI is unavailable." }));
  process.exit(0);
}

if (resolved.status !== 0) {
  const code = payload?.error?.code;
  if (code === "NO_LINK") process.exit(0);
  if (["AMBIGUOUS_LINK", "CORRUPT_LINK", "STALE_LINK"].includes(code)) {
    process.stdout.write(JSON.stringify({ systemMessage: `Context Tree setup warning: ${payload.error.message}` }));
  }
  process.exit(0);
}

const tree = payload?.link?.tree;
if (typeof tree?.path !== "string" || typeof tree?.repository !== "string") process.exit(0);
process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: input.hook_event_name,
      additionalContext: `Context Tree ${tree.repository} is linked at ${tree.path}. Use the Context Tree skills for task-relevant durable context.`,
    },
  }),
);
