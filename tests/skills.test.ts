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
    expect(invocationInputs(init)).toEqual(["repository", "tree_path", "title"]);

    for (const name of ["context-tree-read", "context-tree-write"]) {
      const body = skillBody(name);
      expect(invocationInputs(body)).toEqual(["agent-slug", "tree_path", "branch"]);
      expect(body).toContain("Treat `agent-slug` as the agent identity");
      expect(body).toContain("members/<agent-slug>/memory.md");
    }
  });

  it("omits retired inputs and skill-level policy", () => {
    for (const name of ["context-tree-init", "context-tree-read", "context-tree-write"]) {
      const body = skillBody(name);
      expect(body).not.toMatch(/agent[-_]id/u);
      expect(body).not.toContain("source_artifact");
      expect(body).not.toContain("schemaVersion: 1");
      expect(body).not.toContain("gh auth status");
    }

    const read = skillBody("context-tree-read");
    expect(read).not.toContain("^[A-Za-z0-9]");
    expect(read).not.toContain("`STALE`");

    const write = skillBody("context-tree-write");
    expect(write).not.toContain("^[A-Za-z0-9]");

    for (const body of [read, write]) {
      expect(body).not.toMatch(/validate (?:the )?`?agent-slug|agent-slug.*ASCII|starting with a letter/iu);
    }

    const init = skillBody("context-tree-init");
    expect(init).not.toContain("--public");
    expect(init).toContain('gh repo create "OWNER/REPO" --private');
  });

  it("uses only agent-slug in shipped skills and documentation", () => {
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
      expect(source).not.toMatch(/agent_slug|member_slug|member-slug/u);
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

  it("preserves refresh, isolation, and publication safeguards", () => {
    const read = skillBody("context-tree-read");
    const write = skillBody("context-tree-write");

    expect(read).toContain('git pull --ff-only origin "<branch>"');
    expect(read).toContain("Treat a stale checkout as read-only");
    expect(read).toContain("disclose the refresh");
    expect(read).toContain("exact local commit SHA");

    expect(write).toContain('git fetch origin "<branch>"');
    expect(write).toContain("fetched commit SHA");
    expect(write).toContain("temporary worktree at that exact commit");
    expect(write).toContain("Preserve path containment and never replace or traverse symlinks");
    expect(write).toContain("Run `context-tree verify");
    expect(write).toContain("Inspect the complete `git diff`");
    expect(write).toContain('git push --set-upstream origin "<task-branch>"');
    expect(write).toContain("Use a non-force push");
    expect(write).toContain('gh pr create --repo "OWNER/REPO"');
    expect(write).toContain("Never merge automatically");
  });
});
