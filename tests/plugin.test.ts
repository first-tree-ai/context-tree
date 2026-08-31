import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a mapping.");
  return Object.fromEntries(Object.entries(value));
}

function json(relativePath: string): Record<string, unknown> {
  return record(JSON.parse(readFileSync(resolve(ROOT, relativePath), "utf8")));
}

describe("plugin package contracts", () => {
  const packageManifest = json("package.json");
  const codex = json(".codex-plugin/plugin.json");
  const claude = json(".claude-plugin/plugin.json");

  it("omits the conflicting portable root manifest", () => {
    expect(existsSync(resolve(ROOT, "plugin.json"))).toBe(false);
    expect(packageManifest.files).not.toContain("plugin.json");
  });

  it("retains Codex and Claude Code adapters with synchronized identity", () => {
    for (const adapter of [codex, claude]) {
      expect(adapter.name).toBe("context-tree");
      expect(adapter.version).toBe(packageManifest.version);
      expect(adapter.description).toBe(
        "Context Tree setup, creation, connection, reading, writing, and private publication.",
      );
    }

    expect(codex.skills).toBe("./skills/");
    expect(codex.hooks).toBe("./hooks/hooks.json");
    expect(codex.interface).toBeDefined();
    expect(record(codex.interface).defaultPrompt).toEqual([
      "Set up a Context Tree (create or connect) when this project has none.",
      "Read the relevant Context Tree context for this task.",
      "Write this durable decision to the Context Tree.",
    ]);
    expect(claude).not.toHaveProperty("skills");
    expect(claude).not.toHaveProperty("hooks");
  });

  it("declares Codex hooks explicitly while preserving Claude Code default discovery", () => {
    const hooks = json("hooks/hooks.json");
    const pluginRoot = ["$", "{CLAUDE_PLUGIN_ROOT}"].join("");
    expect(codex.hooks).toBe("./hooks/hooks.json");
    expect(claude).not.toHaveProperty("hooks");
    expect(Object.keys(record(hooks.hooks)).sort()).toEqual(["SessionStart", "SubagentStart"]);
    expect(JSON.stringify(hooks)).toContain(`node \\"${pluginRoot}/hooks/session-start.mjs\\"`);
  });
});
