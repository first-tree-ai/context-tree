import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline";

const [codexHome, projectRoot, marketplacePath] = process.argv.slice(2);
if (!codexHome || !projectRoot || !marketplacePath) {
  throw new Error("Usage: check-codex-plugin-hooks.mjs <codex-home> <project-root> <marketplace.json>");
}

function record(value) {
  assert.equal(typeof value, "object");
  assert.notEqual(value, null);
  assert.equal(Array.isArray(value), false);
  return value;
}

function array(value, label) {
  assert.equal(Array.isArray(value), true, `${label} must be an array`);
  return value;
}

const server = spawn("codex", ["app-server", "--stdio"], {
  cwd: projectRoot,
  env: { ...process.env, CODEX_HOME: codexHome },
  stdio: ["pipe", "pipe", "pipe"],
});
const serverExit = new Promise((resolve) => server.once("exit", resolve));
let nextId = 1;
let stderr = "";
const pending = new Map();

server.stderr.setEncoding("utf8");
server.stderr.on("data", (chunk) => {
  stderr += chunk;
});

const lines = createInterface({ input: server.stdout });
lines.on("line", (line) => {
  let message;
  try {
    message = record(JSON.parse(line));
  } catch {
    return;
  }
  const pendingRequest = pending.get(message.id);
  if (!pendingRequest) return;
  clearTimeout(pendingRequest.timeout);
  pending.delete(message.id);
  if (message.error !== undefined) pendingRequest.reject(new Error(JSON.stringify(message.error)));
  else pendingRequest.resolve(message.result);
});

server.once("exit", (code, signal) => {
  for (const pendingRequest of pending.values()) {
    clearTimeout(pendingRequest.timeout);
    pendingRequest.reject(new Error(`Codex app server exited early (${code ?? signal}). ${stderr}`));
  }
  pending.clear();
});

function request(method, params) {
  const id = nextId;
  nextId += 1;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`Timed out waiting for Codex app-server method ${method}. ${stderr}`));
    }, 10_000);
    pending.set(id, { reject, resolve, timeout });
    server.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

try {
  await request("initialize", {
    capabilities: {},
    clientInfo: { name: "context-tree-hook-check", version: "1.0" },
  });
  server.stdin.write(`${JSON.stringify({ method: "initialized", params: {} })}\n`);

  const pluginResult = record(
    await request("plugin/read", {
      marketplacePath,
      pluginName: "context-tree",
    }),
  );
  const plugin = record(pluginResult.plugin);
  const pluginEvents = array(plugin.hooks, "plugin hooks")
    .map((hook) => record(hook).eventName)
    .sort();
  assert.deepEqual(pluginEvents, ["sessionStart", "subagentStart"]);

  const hooksResult = record(await request("hooks/list", { cwds: [projectRoot] }));
  const cwdResult = record(array(hooksResult.data, "hooks/list data")[0]);
  const discoveredHooks = array(cwdResult.hooks, "discovered hooks")
    .map(record)
    .filter((hook) => hook.pluginId === "context-tree@context-tree-local");
  const discoveredEvents = discoveredHooks.map((hook) => hook.eventName).sort();
  assert.deepEqual(discoveredEvents, ["sessionStart", "subagentStart"]);
  for (const hook of discoveredHooks) {
    assert.equal(hook.source, "plugin");
    assert.equal(hook.enabled, true);
  }

  console.log("Codex discovered the packaged SessionStart and SubagentStart hooks.");
} finally {
  lines.close();
  server.stdin.end();
  server.kill("SIGTERM");
  await serverExit;
}
