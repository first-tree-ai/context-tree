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

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Expected a non-empty string.");
  return value;
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

function skillBody(name: string): string {
  return splitSkill(readFileSync(join(SKILLS_ROOT, name, "SKILL.md"), "utf8")).body;
}

function invocationInputs(body: string): string[] {
  const section = /(?:^|\n)## Invocation inputs\n\n([\s\S]*?)(?=\n## |$)/u.exec(body)?.[1];
  if (section === undefined) throw new Error("Skill must declare its invocation inputs.");
  return [...section.matchAll(/^- `([a-z_-]+)`:/gmu)].map((match) => nonEmptyString(match[1]));
}

function compactWhitespace(value: string): string {
  return value.replace(/\s+/gu, " ");
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

    it(`${name} has valid portable metadata and a non-empty body`, () => {
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
      expect(nonEmptyString(skill.frontmatter.description)).toBe(skill.frontmatter.description);
      expect(skill.frontmatter.license).toBe("Apache-2.0");
      expect(skill.frontmatter.compatibility).toBe(
        "Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.",
      );
      expect(record(skill.frontmatter.metadata)).toEqual({
        author: "first-tree-ai",
        version: PACKAGE_MANIFEST.version,
      });
      expect(skill.body.trim()).not.toBe("");
    });

    it(`${name} has complete OpenAI UI metadata`, () => {
      const openai = record(parse(readFileSync(join(directory, "agents/openai.yaml"), "utf8")));
      const interfaceMetadata = record(openai.interface);

      expect(Object.keys(interfaceMetadata).sort()).toEqual(["default_prompt", "display_name", "short_description"]);
      for (const value of Object.values(interfaceMetadata)) {
        expect(nonEmptyString(value)).toBe(value);
      }
      expect(interfaceMetadata.default_prompt).toContain(`$${name}`);
    });
  }

  it("does not reference the retired shared memory namespace", () => {
    for (const directory of skillDirectories()) {
      const source = readFileSync(join(directory, "SKILL.md"), "utf8");
      expect(source).not.toContain("memory/");
    }
  });

  it("declares the local-checkout invocation contracts", () => {
    const init = skillBody("context-tree-init");
    expect(invocationInputs(init)).toEqual(["repository", "tree_path"]);

    const read = skillBody("context-tree-read");
    expect(invocationInputs(read)).toEqual(["agent_slug", "tree_path", "branch"]);

    const write = skillBody("context-tree-write");
    expect(invocationInputs(write)).toEqual(["agent_slug", "tree_path", "default_branch"]);
    expect(invocationInputs(write)).not.toContain("branch");

    for (const body of [read, write]) {
      expect(body).toContain("Treat `agent_slug` as the agent identity");
      expect(body).toContain("members/<agent_slug>/memory.md");
    }
  });

  it("omits retired inputs and skill-level policy", () => {
    for (const name of ["context-tree-init", "context-tree-read", "context-tree-write"]) {
      const body = skillBody(name);
      expect(body).not.toMatch(/agent[-_]id/u);
      expect(body).not.toContain("source_artifact");
      expect(body).not.toContain("schemaVersion: 1");
    }

    const read = skillBody("context-tree-read");
    expect(read).not.toContain("^[A-Za-z0-9]");
    expect(read).not.toContain("`STALE`");

    const write = skillBody("context-tree-write");
    expect(write).not.toContain("^[A-Za-z0-9]");

    for (const body of [read, write]) {
      expect(body).not.toMatch(/validate (?:the )?`?agent_slug|agent_slug.*ASCII|starting with a letter/iu);
      expect(body).not.toContain("gh auth status");
    }

    const init = skillBody("context-tree-init");
    expect(init).not.toContain("--public");
    expect(init).toContain('gh repo create "OWNER/REPO" --private');
  });

  it("supports safe local-only and private GitHub initialization", () => {
    const init = skillBody("context-tree-init");
    const compactInit = compactWhitespace(init);

    expect(init).toContain("default to `./REPO`");
    expect(init).toContain("unambiguous authoritative task context");
    expect(init).toContain("ask the user; never invent, combine, or replace it");
    expect(init).toContain("ordinary `git init`");
    expect(init).toContain("Git's effective default-branch configuration");
    expect(init).toContain("command -v gh");
    expect(init).toContain("gh auth status --hostname github.com");
    expect(init).toContain('gh api "repos/OWNER/REPO"');
    expect(compactInit).toContain("before writing local files, query the exact `OWNER/REPO`");
    expect(init).toContain("Proceed only when GitHub gives a definite not-found response");
    expect(init).toContain("rather than falling back to local-only creation");
    expect(init).toContain('context-tree init --repository "OWNER/REPO" --tree-path "<tree_path>"');
    expect(init).toContain("treat its JSON scaffold result as authoritative");
    expect(init).toContain("require it to match the scaffold result contract");
    expect(init).toContain("require `verification.ok === true`");
    expect(compactInit).toContain("stop before staging or publishing and preserve the generated repository");
    expect(init).not.toContain("context-tree policy");
    expect(init).not.toContain("context-tree verify");
    expect(init).toContain("Treat the Git repository created by the CLI as authoritative");
    expect(init).toContain('git -C "<tree_path>" symbolic-ref --short HEAD');
    expect(init).toContain("do not run `git init`");
    expect(init).toContain("stage only `NODE.md`, `SCOPE.md`, and `.github/workflows/validate-context-tree.yml`");
    expect(init).toContain("complete staged diff");
    expect(init).toContain("no GitHub repository or remote was created");
    expect(init).toContain("publish only `current_branch`");
    expect(init).toContain("refs/remotes/origin/<current_branch>");
    expect(init).toContain("refs/heads/<current_branch>");
    expect(init).toContain('gh repo edit "OWNER/REPO" --default-branch "<current_branch>"');
    expect(init).toContain("gh repo view \"OWNER/REPO\" --json defaultBranchRef --jq '.defaultBranchRef.name'");
    expect(init).toContain("creation and publication succeeded but default-branch configuration failed");
    expect(compactInit).toContain("report the collision and preserve the local commit");
    expect(init).not.toContain("--title");
    expect(init).not.toContain("<default_branch>");
  });

  it("uses only agent_slug in shipped skills and documentation", () => {
    const paths = [
      resolve(import.meta.dirname, "../README.md"),
      resolve(import.meta.dirname, "../docs/specification.md"),
      resolve(import.meta.dirname, "../policy/context-tree-policy.md"),
      ...skillDirectories().flatMap((directory) => [
        join(directory, "SKILL.md"),
        join(directory, "agents/openai.yaml"),
      ]),
    ];

    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/agent[-]slug|member_slug|member-slug/u);
    }
  });

  it("makes the exact existing checkout the read and write authorization boundary", () => {
    for (const name of ["context-tree-read", "context-tree-write"]) {
      const body = compactWhitespace(skillBody(name));

      expect(body).toContain("Never infer the path from the current directory or clone a replacement");
      expect(body).toContain("real path is identical");
      expect(body).toContain("git rev-parse --show-toplevel");
      expect(body).toContain("git status --porcelain");
      expect(body).toContain("git symbolic-ref --short HEAD");
      expect(body).toContain("Reject a nested root or detached HEAD");
      expect(body).toContain("Capture `origin` without logging it");
      expect(body).toContain("credential-free `github.com` HTTPS or SSH");
      expect(body).toContain("derive `OWNER/REPO`");
      expect(body).toContain("not another checkout or remote");
    }
  });

  it("preserves refresh and isolated direct-publication safeguards", () => {
    const read = skillBody("context-tree-read");
    const write = skillBody("context-tree-write");
    const compactWrite = compactWhitespace(write);

    expect(read).toContain('git pull --ff-only origin "<branch>"');
    expect(read).toContain("Treat a stale checkout as read-only");
    expect(read).toContain("disclose the refresh");
    expect(read).toContain("exact local commit SHA");

    expect(write).toContain('git fetch origin "<default_branch>"');
    expect(write).toContain("git symbolic-ref --short HEAD` to equal `default_branch`");
    expect(write).toContain("Treat the supplied `default_branch` as authoritative");
    expect(write).toContain("never query GitHub to discover or replace it");
    expect(write).toContain("fetched commit SHA");
    expect(write).toContain("temporary worktree at that exact commit");
    expect(write).toContain("Preserve path containment and never replace or traverse symlinks");
    expect(write).toContain("Run `context-tree verify");
    expect(write).toContain("Inspect the complete `git diff`");
    expect(write).toContain('git push origin HEAD:"<default_branch>"');
    expect(write).toContain("Use a non-force push");
    expect(write).toContain("initial direct push plus at most two conflict or race retries");
    expect(write).toContain("git rebase origin/<default_branch>");
    expect(write).toContain("resolve ordinary conflicts locally");
    expect(write).toContain("repository-prescribed checks");
    expect(write).toContain("git diff origin/<default_branch>...HEAD");
    expect(compactWrite).toContain("inspect the authorized remote refs and existing PRs");
    expect(write).toContain("permissions, a ruleset, or branch protection");
    expect(write).toContain('git push --set-upstream origin "<task-branch>"');
    expect(write).toContain('gh pr create --repo "OWNER/REPO" --base "<default_branch>" --head "<task-branch>"');
    expect(compactWrite).toContain("Do not publish a conflicting fallback branch");
    expect(write).toContain("never merge it or request reviewers automatically");
    expect(write).not.toContain("never force push or push directly to the base branch");
    expect(write).not.toContain("do not rebase or force-push");
    expect(write).not.toContain("leave the PR open for humans");
    expect(write).not.toContain('git fetch origin "<branch>"');
    expect(write).not.toContain('gh pr create --repo "OWNER/REPO" --base "<branch>"');
    expect(write).not.toContain("Open a GitHub PR targeting the explicit base");
  });

  it("does not ship the retired PR-first write contract", () => {
    const paths = [
      resolve(import.meta.dirname, "../README.md"),
      resolve(import.meta.dirname, "../docs/specification.md"),
      resolve(import.meta.dirname, "../policy/context-tree-policy.md"),
      join(SKILLS_ROOT, "context-tree-write/SKILL.md"),
      join(SKILLS_ROOT, "context-tree-write/agents/openai.yaml"),
    ];

    for (const path of paths) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(/one source per (?:tree )?PR|repair-only PR|PR-first/iu);
      expect(source).not.toContain("Publish only with a non-force task-branch push and GitHub PR");
    }
  });
});
