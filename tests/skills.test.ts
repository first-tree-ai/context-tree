import { readdirSync, readFileSync, statSync } from "node:fs";
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

describe("Agent Skills instruction contracts (Markdown assertions do not execute Git or publication workflows)", () => {
  it("ships link, init, read, and write skills", () => {
    expect(skillDirectories().map((path) => basename(path))).toEqual([
      "context-tree-init",
      "context-tree-link",
      "context-tree-push",
      "context-tree-read",
      "context-tree-write",
    ]);
  });

  it("ships matching Codex and Claude Code adapter manifests", () => {
    for (const host of ["codex", "claude"]) {
      const manifest = record(
        JSON.parse(readFileSync(resolve(import.meta.dirname, `../.${host}-plugin/plugin.json`), "utf8")),
      );
      expect(manifest.name).toBe("context-tree");
      expect(manifest.version).toBe(PACKAGE_MANIFEST.version);
      expect(nonEmptyString(manifest.description)).toBe(manifest.description);
    }
  });

  it("ships npm-backed Codex and Claude marketplaces without release-version drift", () => {
    const npmSource = {
      package: "@first-tree-ai/context-tree",
      source: "npm",
      version: "latest",
    };
    const codex = record(
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../.agents/plugins/marketplace.json"), "utf8")),
    );
    expect(codex.name).toBe("context-tree");
    expect(record(codex.interface)).toEqual({ displayName: "Context Tree" });
    expect(codex.plugins).toEqual([
      {
        category: "Developer Tools",
        name: "context-tree",
        policy: { authentication: "ON_INSTALL", installation: "AVAILABLE" },
        source: npmSource,
      },
    ]);

    const claude = record(
      JSON.parse(readFileSync(resolve(import.meta.dirname, "../.claude-plugin/marketplace.json"), "utf8")),
    );
    expect(claude.name).toBe("context-tree");
    expect(claude.owner).toEqual({ name: "First Tree AI", url: "https://github.com/first-tree-ai" });
    expect(record(claude.metadata).description).toBe(
      "Install the complete Context Tree plugin for linked, durable project context.",
    );
    expect(claude.plugins).toEqual([
      {
        description: "Complete Context Tree plugin for linking, reading, and publishing durable project context.",
        name: "context-tree",
        source: npmSource,
      },
    ]);

    const packageVersion = nonEmptyString(PACKAGE_MANIFEST.version);
    expect(JSON.stringify(codex)).not.toContain(packageVersion);
    expect(JSON.stringify(claude)).not.toContain(packageVersion);
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

    it(`${name} ships the executable local CLI launcher and uses it for every CLI command`, () => {
      const launcher = join(directory, "scripts/context-tree.mjs");
      expect(statSync(launcher).isFile()).toBe(true);
      expect(statSync(launcher).mode & 0o111).not.toBe(0);
      expect(readFileSync(launcher, "utf8")).toBe(
        readFileSync(join(SKILLS_ROOT, "context-tree-link/scripts/context-tree.mjs"), "utf8"),
      );
      const body = skillBody(name);
      const compactBody = compactWhitespace(body);
      expect(body).toContain('node "<skill-directory>/scripts/context-tree.mjs" --version');
      expect(body).toContain("package-relative `scripts/context-tree.mjs` launcher");
      expect(compactBody).toContain("private CLI bundled in the same plugin package");
      expect(compactBody).toContain("reinstall or update the Context Tree plugin");
      expect(body).not.toMatch(/standalone|global[- ]install|global CLI/iu);
      expect(body).not.toMatch(/`context-tree (?:--version|init|link|policy|read|resolve|verify)\b/u);

      const launcherSource = readFileSync(launcher, "utf8");
      expect(launcherSource).not.toContain('spawnSync("context-tree"');
      expect(launcherSource).not.toContain("npm install --global");
    });
  }

  it("declares automatic-resolution invocation contracts", () => {
    const link = skillBody("context-tree-link");
    expect(invocationInputs(link)).toEqual(["project_path", "tree_path", "repository"]);

    const init = skillBody("context-tree-init");
    expect(invocationInputs(init)).toEqual(["name", "tree_path"]);

    const read = skillBody("context-tree-read");
    expect(invocationInputs(read)).toEqual(["agent_slug"]);

    const write = skillBody("context-tree-write");
    expect(invocationInputs(write)).toEqual(["agent_slug"]);
    expect(invocationInputs(write)).not.toContain("branch");

    for (const body of [read, write]) {
      expect(body).toContain("Treat `agent_slug` as the agent identity");
      expect(body).toContain("members/<agent_slug>/memory.md");
      expect(body).toContain('node "<skill-directory>/scripts/context-tree.mjs" --version');
      expect(body).not.toMatch(/default branch (?:is|named) [`'"]?(?:main|master|trunk)/iu);
      expect(body).toContain("`engineer` or `designer`");
      expect(body).toContain("Never infer it from a global setting or persist it");
    }

    for (const [name, command] of [
      ["context-tree-read", "refresh"],
      ["context-tree-write", "stage"],
    ] as const) {
      const body = compactWhitespace(skillBody(name));
      expect(body).toContain(`node "<skill-directory>/scripts/context-tree.mjs" ${command} --project-path "$PWD"`);
      expect(body).toContain("Do not scan, clone, repair, or run Git");
      expect(body).toContain("clean non-symlink root");
      expect(body).toContain("safe `github.com` origin matches");
    }
  });

  it("supports explicit attach and managed clone link workflows", () => {
    const link = skillBody("context-tree-link");
    expect(link).toContain("Never scan the filesystem for a tree");
    expect(link).toContain("Attach:");
    expect(link).toContain("Managed clone:");
    expect(link).toContain("~/.context-tree/checkouts/OWNER/REPO");
    expect(link).toContain("git clone --origin origin");
    expect(link).toContain(
      'node "<skill-directory>/scripts/context-tree.mjs" link --project-path "<project_path>" --tree-path "<tree_path>"',
    );
    expect(link).toContain("same tree repository");
    expect(link).toContain("do not invoke the normal context-tree-write skill");
    expect(link).toContain("do not require `agent_slug`");
    expect(link).toContain("existing clean, non-symlink Git root");
    expect(link).toContain("writes only the local mapping");
    expect(link).toContain("must not edit, commit, push, or open a pull request");
    expect(link).not.toContain("git ls-remote --symref origin HEAD");
    expect(link).not.toContain("isolated temporary worktree");
    expect(link).not.toContain("gh pr create");
    expect(link).toContain("dirty old checkout");
  });

  it("supports local-only initialization without any GitHub operations", () => {
    const init = skillBody("context-tree-init");
    const compactInit = compactWhitespace(init);

    expect(init).toContain("default to `./name`");
    expect(init).toContain("machine-local links file");
    expect(init).toContain("never embeds the source-project association");
    expect(init).toContain("unambiguous authoritative task context");
    expect(init).toContain("ask the user; never invent, combine, or replace it");
    expect(init).toContain("ordinary `git init`");
    expect(init).toContain("Git's effective default-branch configuration");
    expect(init).toContain('node "<skill-directory>/scripts/context-tree.mjs" init "<name>" --tree-path "<tree_path>"');
    expect(init).toContain("treat its JSON scaffold result as authoritative");
    expect(init).toContain("require it to match the scaffold result contract");
    expect(init).toContain("require `verification.ok === true`");
    expect(init).toContain("including the `branch` and `commit` fields");
    expect(compactInit).toContain("stop and preserve the generated repository");
    expect(init).toContain("commits exactly `NODE.md`, `AGENTS.md`, `CLAUDE.md`, and");
    expect(init).toContain("do not configure a remote");
    expect(init).toContain("no GitHub repository was created");
    expect(init).toContain("context-tree-push skill publishes the tree later");
    expect(init).not.toMatch(/\bgh\b/u);
    expect(init).not.toContain("command -v gh");
    expect(init).not.toContain("credential-free origin");
  });

  it("keeps publication mechanics in the CLI behind a thin push skill", () => {
    const push = skillBody("context-tree-push");
    const compactPush = compactWhitespace(push);

    expect(push).toContain("unambiguous authoritative task context");
    expect(push).toContain("never invent, combine, or replace it");
    expect(push).toContain("Reject repository URLs");
    expect(push).toContain("Support only `github.com`");
    expect(push).toContain(
      'node "<skill-directory>/scripts/context-tree.mjs" push "OWNER/REPO" --tree-path "<tree_path>"',
    );
    expect(push).toContain("omit the argument only to push through an existing origin");
    expect(push).toContain("require the push result contract");
    expect(push).toContain("`uncommittedFiles`");
    expect(compactPush).toContain("pushing ignores them and never stages or commits");
    expect(compactPush).toContain("the CLI creates a new private `OWNER/REPO` repository");
    expect(push).toContain("If GitHub reports that `OWNER/REPO` already exists, stop");
    expect(push).toContain("Never delete a GitHub repository or overwrite remote history");
    expect(push).toContain("inspect `gh repo view`, the local remote, and `git ls-remote`");
    expect(push).not.toContain("gh auth status");
    expect(push).not.toContain("gh repo edit");
    expect(push).not.toContain("git remote add");
  });

  it("preserves refresh and isolated direct-publication safeguards", () => {
    const read = compactWhitespace(skillBody("context-tree-read"));
    const write = skillBody("context-tree-write");
    const compactWrite = compactWhitespace(write);

    expect(read).toContain('node "<skill-directory>/scripts/context-tree.mjs" refresh --project-path "$PWD"');
    expect(read).toContain("Treat a stale checkout as read-only");
    expect(read).toContain("disclose the refresh failure");
    expect(read).toContain("exact commit `sha`");

    expect(write).toContain('git fetch origin "<default_branch>"');
    expect(compactWrite).toContain("creates an isolated worktree at exactly `baseSha`");
    expect(write).toContain("Preserve path containment and never replace or traverse symlinks");
    expect(write).toContain('Run `node "<skill-directory>/scripts/context-tree.mjs" verify');
    expect(write).toContain('node "<skill-directory>/scripts/context-tree.mjs" diff --tree-path "<task-worktree>"');
    expect(write).toContain('git push origin HEAD:"<defaultBranch>"');
    expect(write).toContain("Use a non-force push");
    expect(write).toContain('git -C "<tree_path>" merge --ff-only "<taskBranch>"');
    expect(compactWrite).toContain("no pull-request fallback without a remote");
    expect(compactWrite).toContain("a local-only tree without an origin is staged at its own `HEAD`");
    expect(write).toContain("initial direct push plus at most two conflict or race retries");
    expect(write).toContain("git rebase origin/<default_branch>");
    expect(write).toContain("resolve ordinary conflicts locally");
    expect(write).toContain("repository-prescribed checks");
    expect(write).toContain('diff --tree-path "<task-worktree>" --base "origin/<default_branch>"');
    expect(compactWrite).toContain("inspect the authorized remote refs and existing PRs");
    expect(write).toContain("permissions, a ruleset, or branch protection");
    expect(write).toContain('git push --set-upstream origin "<task-branch>"');
    expect(write).toContain('gh pr create --repo "OWNER/REPO" --base "<default_branch>" --head "<task-branch>"');
    expect(compactWrite).toContain("Do not publish a conflicting fallback branch");
    expect(compactWrite).toContain("never merge it or request reviewers");
    expect(write).not.toContain("never force push or push directly to the base branch");
    expect(write).not.toContain("do not rebase or force-push");
    expect(write).not.toContain("leave the PR open for humans");
    expect(write).not.toContain('git fetch origin "<branch>"');
    expect(write).not.toContain('gh pr create --repo "OWNER/REPO" --base "<branch>"');
    expect(write).not.toContain("Open a GitHub PR targeting the explicit base");
  });
});
