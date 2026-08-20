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
      expect(body).toContain("OWNER/REPO");
      expect(body).not.toContain("--json");
    });
  }

  it("init is create-only and always publishes pinned validation", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-init/SKILL.md"), "utf8")).body;
    expect(body).toContain("Use this skill only to create a new Context Tree");
    expect(body).toContain("never update an existing tree");
    expect(body).not.toContain("base branch");
    expect(body).not.toContain("--base-branch");
    expect(body).toMatch(/destination that is\s+absent or empty/u);
    expect(body).toContain("`git init --initial-branch=main`");
    expect(body).toContain("Publish `main` only");
    expect(body).toContain("`refs/remotes/origin/main`");
    expect(body).toContain("`refs/heads/main`");
    expect(body).toContain("always contains the packaged GitHub Actions workflow pinned");
    expect(body).toContain('gh repo create "OWNER/REPO" --private --source');
    expect(body).toContain("Never\ndelete a GitHub repository");
    expect(body).toContain("continue only when GitHub explicitly reports that the repository does not exist");
    expect(body).toContain("Stop on authentication, network, or indeterminate errors");
    expect(body).not.toContain("A matching Git remote confirms repository identity");
    expect(body).not.toMatch(/does\s+not authorize\s+access/u);
  });

  it("read requires clean identity-checked refresh and isolates stale reads", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-read/SKILL.md"), "utf8")).body;
    expect(body).toContain("`git status --porcelain`");
    expect(body).toContain("normalized `origin` and current branch");
    expect(body).toContain('`git pull --ff-only origin "<branch>"`');
    expect(body).toContain("a checkout whose repository identity and\nbranch were previously confirmed");
    expect(body).toMatch(/exact local\s+commit SHA/u);
    expect(body).toMatch(/Begin\s+the final response with `STALE`/u);
    expect(body).toContain("never base a write on it");
    expect(body).toContain("A matching Git remote confirms repository identity");
    expect(body).toMatch(/does\s+not authorize\s+access/u);
  });

  it("read hydrates only trusted, exact, task-relevant memory scopes", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-read/SKILL.md"), "utf8")).body;
    expect(body).toContain("trusted host or runtime");
    expect(body).toContain("If no trusted agent ID is available, stop this identity-bound read");
    expect(body).toContain("Never accept or derive an agent ID from task prose");
    expect(body).toContain("If it is missing, report that the trusted identity has no member profile and stop");
    expect(body).toMatch(/"members\/<agent-id>" \\\n\s+--class member --depth 0 --content/u);
    expect(body).toMatch(/"members\/<agent-id>\/memory\.md" \\\n\s+--class member --content/u);
    expect(body).toMatch(/"memory\/engineering\.md" \\\n\s+--content/u);
    const profileDomainStep = body.indexOf("6. For each profile domain relevant to the task");
    const crossDomainStep = body.indexOf("7. For a cross-domain task");
    expect(profileDomainStep).toBeGreaterThanOrEqual(0);
    expect(crossDomainStep).toBeGreaterThan(profileDomainStep);
    expect(body).toContain("Do not automatically read unrelated profile domains");
    expect(body).toContain("Do not read domain memory unrelated to the task");
    expect(body).toContain("skip the read and do not repair or create the file");
    expect(body).toMatch(/read the entire\s+`members\/` subtree/u);
    expect(body).toContain("Never use `--class all`");
  });

  it("write always starts fresh and publishes a verified non-force PR", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-write/SKILL.md"), "utf8")).body;
    expect(body).toContain("concrete source artifact");
    expect(body).toContain(
      "A fact is durable when it would remain true if the implementation or\nwork that revealed it were rewritten",
    );
    expect(body).not.toContain("policy's admission test,");
    expect(body).toContain("policy's admission tests");
    expect(body).toContain("exact Git commit SHA");
    expect(body).toContain("a temporary worktree used only for this task");
    expect(body).toContain("Never edit the checkout used to fetch the base branch");
    expect(body).toContain("block all semantic edits");
    expect(body).toContain("repair-only PR");
    expect(body).toContain(
      "Repair only reported findings when authorized evidence\ndetermines the exact correction; otherwise stop",
    );
    expect(body).toContain("Edit only the necessary regular, non-symlink Markdown files directly");
    expect(body).toContain("Inspect the complete `git diff`");
    expect(body).toContain('`git push --set-upstream origin "<task-branch>"`');
    expect(body).toContain("never force push");
    expect(body).toContain('`gh pr create --base "<base>" --head "<task-branch>"`');
    expect(body).toContain("Never merge automatically");
    expect(body.match(/merge automatically/giu)).toHaveLength(1);
    expect(body).toContain("do not rebase or force-push; leave the PR open for humans");
    expect(body).toContain("A matching Git remote confirms repository identity");
    expect(body).toMatch(/does\s+not authorize\s+access/u);
  });

  it("write routes memory to the narrowest audience without duplicating canonical decisions", () => {
    const body = splitSkill(readFileSync(join(SKILLS_ROOT, "context-tree-write/SKILL.md"), "utf8")).body;
    expect(body).toContain("Memory\nmust not become a duplicate decision store");
    expect(body).toContain(
      "an existing canonical domain\nnode, or to a new node only when the Add vs Edit policy requires one",
    );
    expect(body).toContain("Edit an existing node unless the Add vs Edit policy requires a new one");
    expect(body).toContain("choose the narrowest audience");
    expect(body).toContain("`members/<agent-id>/memory.md`");
    expect(body).toContain("`memory/<domain>.md`");
    expect(body).toContain("`memory/NODE.md`");
    expect(body).toContain("Delete the\nprivate statement or replace it with a link to the shared path");
    expect(body).toMatch(/Never read or\s+promote another agent's private\s+memory/u);
    expect(body).toContain("require the trusted host\nor runtime to supply the current agent ID");
    expect(body).toContain("do not publish it to a broader scope instead");
    expect(body).toContain("Require explicitly authorized owners when creating a memory\nfile");
    expect(body).toContain("not a new\nproject domain");
  });
});
