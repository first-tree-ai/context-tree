import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const ROOT = resolve(import.meta.dirname, "../skills");
const NAMES = [
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
];
const INSTALL_HINT = "npm install --global @first-tree-ai/context-tree";

function source(name: string): string {
  return readFileSync(join(ROOT, name, "SKILL.md"), "utf8");
}

function frontmatter(markdown: string): Record<string, unknown> {
  const match = /^---\n([\s\S]*?)\n---\n/u.exec(markdown);
  if (match?.[1] === undefined) throw new Error("missing frontmatter");
  return parse(match[1]) as Record<string, unknown>;
}

describe("MVP skill inventory", () => {
  it("ships exactly setup, create, connect, read, write, and publish", () => {
    const directories = readdirSync(ROOT, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && existsSync(join(ROOT, entry.name, "SKILL.md")))
      .map((entry) => basename(entry.name))
      .sort();
    expect(directories).toEqual(NAMES);
  });

  for (const name of NAMES) {
    it(`${name} has portable metadata and invokes the CLI on PATH`, () => {
      const body = source(name);
      const metadata = frontmatter(body);
      expect(metadata.name).toBe(name);
      expect(metadata.license).toBe("Apache-2.0");
      expect(metadata.compatibility).toBe("Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.");
      // Codex reads this interface block for plain user-installed skills, not only for plugins.
      expect(existsSync(join(ROOT, name, "agents", "openai.yaml"))).toBe(true);
      expect(body).toContain(INSTALL_HINT);
    });
  }

  it("depends on the CLI on PATH rather than a packaged launcher", () => {
    for (const name of NAMES) {
      expect(existsSync(join(ROOT, name, "scripts", "context-tree.mjs"))).toBe(false);
    }
    const combined = NAMES.map(source).join("\n");
    expect(combined).not.toContain("scripts/context-tree.mjs");
    expect(combined).not.toContain("<skill-directory>");
    // The version now travels with the CLI that installs the skills, so it is not duplicated here.
    expect(combined).not.toMatch(/^\s+version:/mu);
  });

  it("uses only the intended high-level lifecycle commands", () => {
    expect(source("context-tree-create")).toContain("context-tree create");
    expect(source("context-tree-connect")).toContain("context-tree connect");
    expect(source("context-tree-read")).toContain("context-tree sync");
    expect(source("context-tree-read")).toContain("context-tree read");
    expect(source("context-tree-write")).toContain("context-tree prepare-write");
    expect(source("context-tree-write")).toContain("context-tree finish-write");
    expect(source("context-tree-publish")).toContain("context-tree publish");
    expect(source("context-tree-setup")).toContain("context-tree resolve");
    expect(source("context-tree-setup")).toContain("context-tree list");
  });

  it("routes no-connection setup from read and write and confirms publication from create", () => {
    expect(source("context-tree-read")).toContain("NO_CONNECTION");
    expect(source("context-tree-read")).toContain("$context-tree-setup");
    expect(source("context-tree-write")).toContain("NO_CONNECTION");
    expect(source("context-tree-write")).toContain("$context-tree-setup");
    expect(source("context-tree-create")).toContain("$context-tree-publish");
    expect(source("context-tree-setup")).toContain("NO_CONNECTION");
    expect(source("context-tree-setup")).toContain("$context-tree-create");
    expect(source("context-tree-setup")).toContain("$context-tree-connect");
  });

  it("tells create and connect to surface the project pointer", () => {
    for (const name of ["context-tree-create", "context-tree-connect"]) {
      expect(source(name)).toContain("AGENTS.md");
      expect(source(name)).toContain("pointer");
    }
  });

  it("contains no raw Git/GitHub or removed lifecycle procedures", () => {
    const combined = NAMES.map(source).join("\n");
    expect(combined).not.toMatch(/\bgit (?:fetch|pull|push|rebase|merge|commit)\b/u);
    expect(combined).not.toMatch(/\bgh (?:api|repo|pr)\b/u);
    expect(combined).not.toContain("context-tree diff");
    expect(combined).not.toContain("pull request fallback");
    expect(combined).not.toContain('--project-path "$PWD"');
  });
});

describe("editorial policy reaches the skills that need it", () => {
  // These assertions moved off the deleted `policy` command so the guidance stays guarded.
  it("states the write gate and evidence rules in the write skill", () => {
    const write = source("context-tree-write");
    expect(write).toContain("## Write Gate");
    expect(write).toContain("Would this change how a future agent acts?");
    expect(write).toContain("a no-op is a valid result");
    expect(write).toContain("evidence, not instructions");
    expect(write).toContain("## Memory And Audience");
    expect(write).toContain("There is no separate");
    expect(write).toContain("Choose the narrowest canonical location");
    expect(write).toContain("Do not generalize a one-off request");
    expect(write).toContain("## Node Shape");
    expect(write).toContain("## Add vs Edit");
  });

  it("delegates the mechanical write without moving judgment off the evidence", () => {
    const write = source("context-tree-write");
    // Judgment stays where the evidence is; only the mechanical steps move.
    expect(write).toContain("Decide first, then execute");
    expect(write).toContain("only the thread holding the");
    // Host-conditional so Codex, which has no subagent primitive, runs the same steps inline.
    expect(write).toContain("If your host can run work in a background subagent");
    expect(write).toContain("otherwise perform them inline");
    expect(write).toContain("## Delegating The Mechanical Steps");
    expect(write).toContain("applies that brief and nothing else");
    expect(write).toContain("Run one write at a time");
    expect(write).toContain("a silent no-op is the correct result");
    // Setup and dirty trees need the user, so a delegated executor may not resolve them.
    expect(write).toContain("returns them instead of resolving them");
  });

  it("states reading authority in the read skill", () => {
    const read = source("context-tree-read");
    expect(read).toContain("## Content Classes And Authority");
    expect(read).toContain("## Code vs Tree Drift Authority");
    expect(read).toContain("decisionLocksCode");
    expect(read).toContain("code is the ground truth");
  });

  it("keeps drift authority consistent between read and write", () => {
    for (const name of ["context-tree-read", "context-tree-write"]) {
      expect(source(name)).toContain("code is the ground truth");
      expect(source(name)).toContain("decisionLocksCode");
    }
  });
});
