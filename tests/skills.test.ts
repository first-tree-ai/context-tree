import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
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
const PACKAGED_CLI = 'node "<skill-directory>/scripts/context-tree.mjs"';

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
    it(`${name} has portable metadata and invokes the package-bound launcher`, () => {
      const body = source(name);
      const metadata = frontmatter(body);
      expect(metadata.name).toBe(name);
      expect(metadata.license).toBe("Apache-2.0");
      expect(metadata.compatibility).toBe("Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.");
      expect(body).toContain(`${PACKAGED_CLI} --version`);
      const launcher = join(ROOT, name, "scripts", "context-tree.mjs");
      expect(statSync(launcher).isFile()).toBe(true);
      expect(statSync(launcher).mode & 0o111).not.toBe(0);
      expect(readFileSync(launcher, "utf8")).toBe(
        readFileSync(join(ROOT, "context-tree-connect", "scripts", "context-tree.mjs"), "utf8"),
      );
      expect(existsSync(join(ROOT, name, "agents", "openai.yaml"))).toBe(true);

      const launcherSource = readFileSync(launcher, "utf8");
      expect(launcherSource).not.toContain('spawnSync("context-tree"');
      expect(launcherSource).not.toContain("npm install");
    });
  }

  it("uses only the intended high-level lifecycle commands", () => {
    expect(source("context-tree-create")).toContain(`${PACKAGED_CLI} create`);
    expect(source("context-tree-connect")).toContain(`${PACKAGED_CLI} connect`);
    expect(source("context-tree-read")).toContain(`${PACKAGED_CLI} sync`);
    expect(source("context-tree-read")).toContain(`${PACKAGED_CLI} read`);
    expect(source("context-tree-write")).toContain(`${PACKAGED_CLI} prepare-write`);
    expect(source("context-tree-write")).toContain(`${PACKAGED_CLI} finish-write`);
    expect(source("context-tree-publish")).toContain(`${PACKAGED_CLI} publish`);
    expect(source("context-tree-setup")).toContain(`${PACKAGED_CLI} resolve`);
    expect(source("context-tree-setup")).toContain(`${PACKAGED_CLI} list`);
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

  it("contains no raw Git/GitHub or removed lifecycle procedures", () => {
    const combined = NAMES.map(source).join("\n");
    expect(combined).not.toMatch(/\bgit (?:fetch|pull|push|rebase|merge|commit)\b/u);
    expect(combined).not.toMatch(/\bgh (?:api|repo|pr)\b/u);
    expect(combined).not.toContain("context-tree diff");
    expect(combined).not.toContain("pull request fallback");
    expect(combined).not.toContain('--project-path "$PWD"');
  });
});
