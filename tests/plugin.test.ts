import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const PORTABLE_SCHEMA = "https://agent-plugins.org/schemas/1.0.0/plugin.schema.json";
const PORTABLE_FIELDS = [
  "$schema",
  "author",
  "description",
  "homepage",
  "keywords",
  "license",
  "name",
  "repository",
  "version",
];

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a mapping.");
  return Object.fromEntries(Object.entries(value));
}

function json(relativePath: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8")));
}

describe("Agent Plugins package contracts", () => {
  const packageManifest = json("package.json");
  const portableManifest = json("plugin.json");

  it("ships a closed Agent Plugins v1.0.0 portable manifest", () => {
    expect(portableManifest.$schema).toBe(PORTABLE_SCHEMA);
    expect(Object.keys(portableManifest).sort()).toEqual(PORTABLE_FIELDS);
    expect(portableManifest).not.toHaveProperty("skills");
    expect(portableManifest).not.toHaveProperty("hooks");
    expect(portableManifest).not.toHaveProperty("interface");
    expect(portableManifest).not.toHaveProperty("extensions");
    expect(portableManifest).not.toHaveProperty("mcpServers");
  });

  it("uses a conformant portable name and synchronized standard metadata", () => {
    const name = portableManifest.name;
    expect(typeof name).toBe("string");
    if (typeof name !== "string") throw new Error("Portable plugin name must be a string.");
    expect(name.length).toBeGreaterThanOrEqual(1);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toMatch(/^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/u);
    expect(name).not.toContain("--");
    expect(name).not.toContain("..");

    expect(portableManifest).toEqual({
      $schema: PORTABLE_SCHEMA,
      author: { name: "First Tree AI", url: "https://github.com/first-tree-ai" },
      description: "Complete Context Tree plugin with linking, reading, durable writes, and a packaged CLI.",
      homepage: "https://github.com/first-tree-ai/context-tree",
      keywords: ["context-tree", "memory", "agents"],
      license: "Apache-2.0",
      name: "context-tree",
      repository: "https://github.com/first-tree-ai/context-tree",
      version: packageManifest.version,
    });
  });

  it("retains Codex and Claude Code adapters with synchronized identity", () => {
    const codex = json(".codex-plugin/plugin.json");
    const claude = json(".claude-plugin/plugin.json");

    for (const adapter of [codex, claude]) {
      expect(adapter.name).toBe(portableManifest.name);
      expect(adapter.version).toBe(packageManifest.version);
      expect(adapter.description).toBe(portableManifest.description);
    }

    expect(codex.skills).toBe("./skills/");
    expect(codex.interface).toBeDefined();
    expect(codex).not.toHaveProperty("hooks");
    expect(claude).not.toHaveProperty("skills");
    expect(claude).not.toHaveProperty("hooks");
  });

  it("keeps native hooks at their default discovery path", () => {
    const hooks = json("hooks/hooks.json");
    const pluginRoot = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
    expect(Object.keys(record(hooks.hooks)).sort()).toEqual(["SessionStart", "SubagentStart"]);
    expect(JSON.stringify(hooks)).toContain(`node \\"${pluginRoot}/hooks/session-start.mjs\\"`);
  });
});
