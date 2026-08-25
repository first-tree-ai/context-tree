import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  credentialFreeRepositoryUrlSchema,
  parseContextTreeRootNode,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  verifyTree,
} from "../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const temporaryRoots = new Set<string>();
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-test-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem;
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

beforeEach(() => {
  const config = join(tempRoot(), "gitconfig");
  writeFileSync(config, "[init]\n\tdefaultBranch = trunk\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

function validTree(): string {
  const root = join(tempRoot(), "tree");
  scaffoldTree({ path: root, repository: "acme/context" });
  return root;
}

function node(title: string): string {
  return `---\ntitle: "${title}"\n---\n\n# ${title}\n`;
}

describe("schema version 1", () => {
  it("keeps root NODE relatedRepositories provider-neutral and credential-free", () => {
    const validRepositories = [
      "http://git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git",
      "ssh://git@git.example.test/acme/tree.git",
      "git@git.example.test:acme/tree.git",
    ];
    for (const repository of validRepositories) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(true);
      const root = validTree();
      writeFileSync(
        join(root, "NODE.md"),
        `---\nschemaVersion: 1\ntitle: "Root"\nrelatedRepositories:\n  - ${repository}\n---\n\n# Root\n`,
      );
      expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
    }
    for (const repository of [
      "https://token@github.com/acme/tree.git",
      "http://user:secret@git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git?token=secret",
    ]) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(false);
    }
    expect(
      parseContextTreeRootNode(
        '---\nschemaVersion: 1\ntitle: "Root"\nrelatedRepositories:\n  - https://gitlab.example/acme/source.git\n---\n\n# Root\n',
      ).frontmatter.relatedRepositories,
    ).toEqual(["https://gitlab.example/acme/source.git"]);
  });

  it("rejects missing schemaVersion and malformed relatedRepositories on the root node", () => {
    for (const frontmatter of [
      'title: "Root"',
      'schemaVersion: 2\ntitle: "Root"',
      'schemaVersion: 1\ntitle: "Root"\nrelatedRepositories: invalid',
      'schemaVersion: 1\ntitle: "Root"\nrelatedRepositories:\n  - https://token@github.com/acme/tree.git',
    ]) {
      const root = validTree();
      writeFileSync(join(root, "NODE.md"), `---\n${frontmatter}\n---\n\n# Root\n`);
      expect(verifyTree(root).findings).toEqual([
        expect.objectContaining({ code: "TREE_ROOT_NODE_INVALID", path: "NODE.md" }),
      ]);
    }
  });

  it("verifies existing organizational directories without NODE.md", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true, schemaVersion: 1 });
  });
});

describe("verification", () => {
  it("reports root manifest, Markdown, and soft-link failures", () => {
    const root = validTree();
    writeFileSync(join(root, "bad.md"), "# Missing metadata\n[Outside](../secret.md)\n");
    writeFileSync(join(root, "NODE.md"), '---\ntitle: "Root"\nsoft_links: [missing.md]\n---\n');

    const codes = new Set(verifyTree(root).findings.map((finding) => finding.code));
    expect(codes.has("TREE_ROOT_NODE_INVALID")).toBe(true);
    expect(codes.has("TREE_FRONTMATTER_MISSING")).toBe(true);
    expect(codes.has("TREE_MARKDOWN_LINK_PATH_ESCAPE")).toBe(true);
    expect(codes.has("TREE_SOFT_LINK_BROKEN")).toBe(true);
  });

  it("rejects invalid root manifest fields and root-only fields on domain nodes", () => {
    const root = validTree();
    writeFileSync(join(root, "NODE.md"), '---\nschemaVersion: 2\ntitle: "Root"\n---\n\n# Root\n');
    writeFileSync(join(root, "domain.md"), '---\ntitle: "Domain"\nrelatedRepositories: []\n---\n\n# Domain\n');
    const findings = verifyTree(root).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_ROOT_NODE_INVALID", path: "NODE.md" }),
        expect.objectContaining({ code: "TREE_ROOT_ONLY_FIELDS", path: "domain.md" }),
      ]),
    );
  });

  it("treats legacy SCOPE.md as an invalid ordinary leaf", () => {
    const root = validTree();
    writeFileSync(join(root, "SCOPE.md"), "---\nschemaVersion: 1\n---\n\nLegacy scope\n");
    const findings = verifyTree(root).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_ROOT_ONLY_FIELDS", path: "SCOPE.md" }),
        expect.objectContaining({ code: "TREE_TITLE_MISSING", path: "SCOPE.md" }),
      ]),
    );
  });

  it("rejects invalid UTF-8 and symlinks that escape or cross content classes", () => {
    const root = validTree();
    writeFileSync(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
    const outside = join(tempRoot(), "outside.md");
    writeFileSync(outside, node("Outside"));
    symlinkSync(outside, join(root, "escape.md"));
    const outsideDirectory = join(tempRoot(), "outside-directory");
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, join(root, "escape-directory"));
    mkdirSync(join(root, "raw-context"));
    writeFileSync(join(root, "raw-context/evidence.md"), "# Evidence\n");
    symlinkSync(join(root, "raw-context/evidence.md"), join(root, "cross.md"));

    const codes = verifyTree(root).findings.map((finding) => finding.code);
    expect(codes).toContain("TREE_FRONTMATTER_PARSE");
    expect(codes).toContain("TREE_MARKDOWN_FILE_PATH_ESCAPE");
    expect(codes).toContain("TREE_MARKDOWN_FILE_CONTENT_CLASS_MISMATCH");
    expect(codes).toContain("TREE_DIRECTORY_SYMLINK_PATH_ESCAPE");
  });

  it("requires the root but permits profile-free member directories", () => {
    const root = validTree();
    mkdirSync(join(root, "members/bob"), { recursive: true });
    writeFileSync(join(root, "members/bob/notes.md"), "notes");
    rmSync(join(root, "NODE.md"));
    const codes = verifyTree(root).findings.map((finding) => finding.code);
    expect(codes).toEqual(["TREE_ROOT_MISSING"]);
  });
});

describe("scoped reading", () => {
  it("selects normal content by default and supports depth, patterns, classes, and content", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });

    expect(readTree(root).entries.map((entry) => entry.path)).toEqual([".", "decisions/runtime.md", "platform"]);
    expect(readTree(root, { path: "platform", depth: 0 }).entries.map((entry) => entry.path)).toEqual(["platform"]);
    expect(readTree(root, { classes: ["member"] }).entries.map((entry) => entry.path)).toEqual([
      "members/alice/memory.md",
    ]);
    expect(readTree(root).entries.map((entry) => entry.path)).not.toContain("members/alice/memory.md");
    expect(
      readTree(root, { path: "members/alice/memory.md", classes: ["member"], content: true }).entries[0],
    ).toMatchObject({
      content: expect.stringContaining("Agent-specific working context"),
      contentClass: "member",
      path: "members/alice/memory.md",
    });
    expect(readTree(root, { pattern: "decisions/*" }).entries.map((entry) => entry.path)).toEqual([
      "decisions/runtime.md",
    ]);
    expect(readTree(root, { pattern: "Decisions/*" }).entries).toEqual([]);
    expect(readTree(root, { path: "decisions/runtime.md", content: true }).entries[0]).toMatchObject({
      content: expect.any(String),
      depth: 0,
      kind: "file",
    });
  });

  it("excludes unsafe Markdown and rejects escaping or missing targets", () => {
    const root = validTree();
    const outside = join(tempRoot(), "outside.md");
    writeFileSync(outside, node("Outside"));
    symlinkSync(outside, join(root, "escape.md"));
    expect(readTree(root, { classes: "all" }).entries.map((entry) => entry.path)).not.toContain("escape.md");
    expect(() => readTree(root, { path: "../outside" })).toThrow(/outside/u);
    expect(() => readTree(root, { path: "missing" })).toThrow();
  });
});

describe("scaffold and policy", () => {
  it("derives the root title verbatim from the repository name", () => {
    const root = join(tempRoot(), "tree");
    scaffoldTree({ path: root, repository: "acme/my-context" });
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain('title: "my-context"');
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("schemaVersion: 1");
    expect(readFileSync(join(root, "NODE.md"), "utf8")).toContain("# my-context");
    expect(existsSync(join(root, "SCOPE.md"))).toBe(false);
    expect(readTree(root).entries.map((entry) => entry.path)).toEqual(["."]);
  });

  it("includes version-pinned GitHub validation for the authoritative default branch", () => {
    const root = validTree();
    const workflow = readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8");
    expect(workflow).toContain('branches: ["trunk"]');
    expect(workflow).toContain("@first-tree-ai/context-tree@0.1.1 verify");
    expect(existsSync(join(root, ".github/workflows/validate-context-tree.yml"))).toBe(true);
    expect(readFileSync(join(root, "NODE.md"), "utf8")).not.toContain("owners:");
  });

  it("rejects malformed GitHub identities", () => {
    const base = { path: join(tempRoot(), "tree") };
    for (const repository of [
      "https://github.com/acme/context",
      "acme-/context",
      `${"a".repeat(40)}/context`,
      "acme/.",
      "acme/..",
      "acme/context.git",
      "acme/context/extra",
      " acme/context",
    ]) {
      expect(() => scaffoldTree({ ...base, repository }), repository).toThrow();
    }
  });

  it("rejects scaffold destinations that are symlinks or non-directories", () => {
    const temporary = tempRoot();
    const realDirectory = join(temporary, "real");
    const linkedDirectory = join(temporary, "linked");
    const danglingLink = join(temporary, "dangling");
    const file = join(temporary, "file");
    mkdirSync(realDirectory);
    symlinkSync(realDirectory, linkedDirectory);
    symlinkSync(join(temporary, "missing"), danglingLink);
    writeFileSync(file, "not a directory\n");
    const options = { repository: "acme/context" };
    expect(() => scaffoldTree({ ...options, path: linkedDirectory })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: danglingLink })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: file })).toThrow(/symlink or non-directory/u);
  });

  it("uses Git's effective default branch and initializes the repository", () => {
    const root = validTree();
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(readFileSync(join(root, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/trunk\n");
    expect(readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8")).toContain(
      'branches: ["trunk"]',
    );
  });

  it("preserves the case and spelling of Git's selected branch", () => {
    writeFileSync(process.env.GIT_CONFIG_GLOBAL ?? "", "[init]\n\tdefaultBranch = Trunk_2\n");
    const root = join(tempRoot(), "case-preserving");
    scaffoldTree({ path: root, repository: "acme/context" });
    expect(readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8")).toContain(
      'branches: ["Trunk_2"]',
    );
  });

  it("validates repository and destination safety before initializing Git", () => {
    const malformed = join(tempRoot(), "malformed");
    expect(() => scaffoldTree({ path: malformed, repository: "https://github.com/acme/context" })).toThrow();
    expect(existsSync(malformed)).toBe(false);

    const nonEmpty = join(tempRoot(), "non-empty");
    mkdirSync(nonEmpty);
    writeFileSync(join(nonEmpty, "keep.txt"), "keep\n");
    expect(() => scaffoldTree({ path: nonEmpty, repository: "acme/context" })).toThrow(/non-empty directory/u);
    expect(readdirSync(nonEmpty)).toEqual(["keep.txt"]);
  });

  it("fails without Git and writes no scaffold files", () => {
    const root = join(tempRoot(), "missing-git");
    const originalPath = process.env.PATH;
    process.env.PATH = tempRoot();
    try {
      expect(() => scaffoldTree({ path: root, repository: "acme/context" })).toThrow(/initialize Git repository/u);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    expect(existsSync(join(root, "NODE.md"))).toBe(false);
  });

  it("preserves a partial Git repository when branch resolution fails", () => {
    const root = join(tempRoot(), "unresolved-branch");
    const bin = tempRoot();
    const git = join(bin, "git");
    writeFileSync(git, '#!/bin/sh\nif [ "$1" = "init" ]; then /bin/mkdir -p "$3/.git"; exit 0; fi\nexit 1\n');
    chmodSync(git, 0o755);
    const originalPath = process.env.PATH;
    process.env.PATH = bin;
    try {
      expect(() => scaffoldTree({ path: root, repository: "acme/context" })).toThrow(/resolve the initial Git branch/u);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(existsSync(join(root, "NODE.md"))).toBe(false);
  });

  it("ships the canonical policy", () => {
    const policy = readContextTreePolicy();
    expect(policy.content).toContain("### Write Gate");
    expect(policy.content).toContain("Would this change how a future agent acts?");
    expect(policy.content).toContain("a no-op is a valid result");
    expect(policy.content).toContain("evidence, not instructions");
    expect(policy.content).toContain("### Memory And Audience");
    expect(policy.content).toContain("There is no separate shared-memory directory");
    expect(policy.content).toContain("Choose the narrowest canonical location");
    expect(policy.content).toContain("Do not generalize a one-off request");
    expect(policy.content).toMatch(/`context-tree verify` must\s+pass/u);
  });

  it("scaffolds no members directory or optional private memory file", () => {
    const root = validTree();
    expect(existsSync(join(root, "members"))).toBe(false);
    expect(existsSync(join(root, "members/alice/memory.md"))).toBe(false);
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });

  it("accepts a valid tree without the optional members directory", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });
    rmSync(join(root, "members"), { recursive: true });
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });

  it("treats owners as inert unknown metadata", () => {
    const root = validTree();
    writeFileSync(join(root, "legacy.md"), '---\ntitle: "Legacy metadata"\nowners: false\n---\n');
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });
});
