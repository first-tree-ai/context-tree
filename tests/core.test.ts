import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  credentialFreeRepositoryUrlSchema,
  parseContextTreeScope,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  verifyTree,
} from "../src/index.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const temporaryRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-test-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

function validTree(): string {
  const root = join(tempRoot(), "tree");
  scaffoldTree({ owner: "alice", path: root, repository: "acme/context", title: "Acme" });
  return root;
}

function node(title: string): string {
  return `---\ntitle: "${title}"\nowners: [alice]\n---\n\n# ${title}\n`;
}

describe("schema version 1", () => {
  it("keeps SCOPE relatedRepositories provider-neutral and credential-free", () => {
    for (const repository of [
      "http://git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git",
      "ssh://git@git.example.test/acme/tree.git",
      "git@git.example.test:acme/tree.git",
    ]) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(true);
    }
    for (const repository of [
      "https://token@github.com/acme/tree.git",
      "http://user:secret@git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git?token=secret",
    ]) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(false);
    }
    expect(
      parseContextTreeScope(
        "---\nschemaVersion: 1\nrelatedRepositories:\n  - https://gitlab.example/acme/source.git\n---\n\nScope\n",
      ).frontmatter.relatedRepositories,
    ).toEqual(["https://gitlab.example/acme/source.git"]);
  });

  it("verifies existing organizational directories without NODE.md", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true, schemaVersion: 1 });
  });
});

describe("verification", () => {
  it("reports metadata, member, SCOPE, Markdown, and soft-link failures", () => {
    const root = validTree();
    writeFileSync(join(root, "SCOPE.md"), "not frontmatter\n");
    writeFileSync(join(root, "bad.md"), "# Missing metadata\n[Outside](../secret.md)\n");
    writeFileSync(join(root, "NODE.md"), '---\ntitle: "Root"\nowners: [alice]\nsoft_links: [missing.md]\n---\n');
    writeFileSync(join(root, "members/alice/NODE.md"), '---\ntitle: "Alice"\nowners: []\ntype: robot\n---\n');

    const codes = new Set(verifyTree(root).findings.map((finding) => finding.code));
    expect(codes.has("TREE_SCOPE_INVALID")).toBe(true);
    expect(codes.has("TREE_FRONTMATTER_MISSING")).toBe(true);
    expect(codes.has("TREE_MARKDOWN_LINK_PATH_ESCAPE")).toBe(true);
    expect(codes.has("TREE_SOFT_LINK_BROKEN")).toBe(true);
    expect(codes.has("TREE_MEMBER_OWNERS_INVALID")).toBe(true);
    expect(codes.has("TREE_MEMBER_TYPE_INVALID")).toBe(true);
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

  it("requires root and direct member nodes", () => {
    const root = validTree();
    mkdirSync(join(root, "members/bob"));
    writeFileSync(join(root, "members/bob/notes.md"), "notes");
    rmSync(join(root, "NODE.md"));
    const codes = verifyTree(root).findings.map((finding) => finding.code);
    expect(codes).toContain("TREE_ROOT_MISSING");
    expect(codes).toContain("TREE_MEMBER_NODE_MISSING");
  });
});

describe("scoped reading", () => {
  it("selects normal content by default and supports depth, patterns, classes, and content", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });

    expect(readTree(root).entries.map((entry) => entry.path)).toEqual([
      ".",
      "decisions/runtime.md",
      "platform",
      "SCOPE.md",
    ]);
    expect(readTree(root, { path: "platform", depth: 0 }).entries.map((entry) => entry.path)).toEqual(["platform"]);
    expect(readTree(root, { classes: ["member"] }).entries.map((entry) => entry.path)).toEqual([
      "members",
      "members/alice",
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
  it("always includes version-pinned GitHub validation for main", () => {
    const root = validTree();
    const workflow = readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8");
    expect(workflow).toContain('branches: ["main"]');
    expect(workflow).toContain("@first-tree-ai/context-tree@0.1.0 verify");
    expect(existsSync(join(root, ".github/workflows/validate-context-tree.yml"))).toBe(true);
  });

  it("rejects malformed GitHub identities", () => {
    const base = { owner: "alice", path: join(tempRoot(), "tree"), title: "Acme" };
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
    const options = { owner: "alice", repository: "acme/context", title: "Acme" };
    expect(() => scaffoldTree({ ...options, path: linkedDirectory })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: danglingLink })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: file })).toThrow(/symlink or non-directory/u);
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

  it("accepts trees with no optional private memory file", () => {
    const root = validTree();
    expect(existsSync(join(root, "members/alice/memory.md"))).toBe(false);
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });

  it("accepts a valid tree without optional private memory", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });
    rmSync(join(root, "members/alice/memory.md"));
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });
});
