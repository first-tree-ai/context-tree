import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SKILLS_ROOT = resolve(import.meta.dirname, "../skills");
const PACKAGE_MANIFEST = record(JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")));

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a mapping.");
  return Object.fromEntries(Object.entries(value));
}

function skillDirectories(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_ROOT, entry.name))
    .sort();
}

function splitSkill(source: string): { body: string; frontmatter: Record<string, unknown> } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match?.[1]) throw new Error("SKILL.md must contain YAML frontmatter.");
  return { body: match[2] ?? "", frontmatter: record(parse(match[1])) };
}

describe("Agent Skills contracts", () => {
  it("ships only init, read, and write skills", () => {
    expect(skillDirectories().map((path) => basename(path))).toEqual([
      "context-tree-init",
      "context-tree-read",
      "context-tree-write",
    ]);
  });

  for (const directory of skillDirectories()) {
    const name = basename(directory);

    it(`${name} has portable metadata and matching OpenAI UI metadata`, () => {
      const source = readFileSync(join(directory, "SKILL.md"), "utf8");
      const skill = splitSkill(source);
      expect(Object.keys(skill.frontmatter).sort()).toEqual([
        "compatibility",
        "description",
        "license",
        "metadata",
        "name",
      ]);
      expect(skill.frontmatter.name).toBe(name);
      expect(skill.frontmatter.license).toBe("Apache-2.0");
      expect(skill.frontmatter.compatibility).toBe(
        "Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.",
      );
      expect(record(skill.frontmatter.metadata)).toEqual({
        author: "first-tree-ai",
        version: PACKAGE_MANIFEST.version,
      });
      const openai = record(parse(readFileSync(join(directory, "agents/openai.yaml"), "utf8")));
      expect(record(openai.interface).default_prompt).toContain(`$${name}`);
    });

    it(`${name} checks the CLI and policy before use and never auto-installs`, () => {
      const body = splitSkill(readFileSync(join(directory, "SKILL.md"), "utf8")).body;
      const versionCheck = body.indexOf("`context-tree --version`");
      const policyCheck = body.indexOf("`context-tree policy`");
      expect(versionCheck).toBeGreaterThanOrEqual(0);
      expect(policyCheck).toBeGreaterThan(versionCheck);
      expect(body).toContain("`npm install --global @first-tree-ai/context-tree`");
      expect(body).toMatch(/Never install a\s+package automatically\./u);
      expect(body).toContain("`schemaVersion: 1`");
      expect(body).toContain("A Git remote proves identity, not user authority");
      expect(body).toContain("OWNER/REPO");
      expect(body).not.toContain("--json");
    });
  }

  it("init is create-only and always publishes pinned validation", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-init/SKILL.md"), "utf8")).body;
    expect(body).toContain("Create only");
    expect(body).not.toContain("base branch");
    expect(body).not.toContain("--base-branch");
    expect(body).toMatch(/empty\s+local destination/u);
    expect(body).toContain("`git init --initial-branch=main`");
    expect(body).toContain("publish `main` only");
    expect(body).toContain("`refs/remotes/origin/main`");
    expect(body).toContain("`refs/heads/main`");
    expect(body).toContain("always contains the packaged GitHub Actions workflow pinned");
    expect(body).toContain('gh repo create "OWNER/REPO" --private --source');
    expect(body).toContain("Never\ndelete a GitHub repository");
    expect(body).toContain("Stop if the target\nrepository already exists");
  });

  it("read requires clean identity-checked refresh and isolates stale reads", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-read/SKILL.md"), "utf8")).body;
    expect(body).toContain("`git status --porcelain`");
    expect(body).toContain("normalized `origin` and current branch");
    expect(body).toContain('`git pull --ff-only origin "<branch>"`');
    expect(body).toContain("explicitly authorizes a stale read");
    expect(body).toContain("exact local commit SHA");
    expect(body).toContain("A stale checkout is\nread-only and must never be reused as the starting point for a write");
  });

  it("write always starts fresh and publishes a verified non-force PR", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-write/SKILL.md"), "utf8")).body;
    expect(body).toContain("concrete source artifact");
    expect(body).toContain("exact fetched commit");
    expect(body).toContain("agent-owned isolated worktree");
    expect(body).toContain("Never edit the shared checkout");
    expect(body).toContain("block all semantic edits");
    expect(body).toContain("repair-only PR");
    expect(body).toContain("Edit only the necessary regular, non-symlink Markdown files directly");
    expect(body).toContain("Inspect the complete `git diff`");
    expect(body).toContain('`git push --set-upstream origin "<task-branch>"`');
    expect(body).toContain("never force push");
    expect(body).toContain('`gh pr create --base "<base>" --head "<task-branch>"`');
    expect(body).toContain("Never merge automatically");
  });
});
