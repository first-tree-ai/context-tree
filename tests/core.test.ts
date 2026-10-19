import { cpSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { readTree } from "../src/tree/read.js";
import { scaffoldTree } from "../src/tree/scaffold.js";
import { verifyTree } from "../src/tree/verify.js";

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
  scaffoldTree(root, "context");
  return root;
}

function node(title: string): string {
  return `---\ntitle: "${title}"\n---\n\n# ${title}\n`;
}

describe("schema version 1", () => {
  it("rejects missing or unsupported schemaVersion on the root node", () => {
    for (const frontmatter of ['title: "Root"', 'schemaVersion: 2\ntitle: "Root"']) {
      const root = validTree();
      writeFileSync(join(root, "NODE.md"), `---\n${frontmatter}\n---\n\n# Root\n`);
      expect(verifyTree(root).findings).toContainEqual(
        expect.objectContaining({ code: "TREE_ROOT_NODE_INVALID", path: "NODE.md" }),
      );
    }
  });
});

describe("verification", () => {
  it("accepts a valid indexed tree fixture", () => {
    expect(verifyTree(join(FIXTURES, "valid"))).toMatchObject({ findings: [], ok: true });
  });

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

  it("preserves findings for valid, missing, escaping, symlinked, and non-local links", () => {
    const root = validTree();
    writeFileSync(join(root, "target.md"), node("Target"));
    const outside = join(tempRoot(), "outside");
    mkdirSync(outside);
    writeFileSync(join(outside, "NODE.md"), node("Outside"));
    symlinkSync(outside, join(root, "escaped-directory"));
    writeFileSync(
      join(root, "links.md"),
      [
        "---",
        'title: "Links"',
        "soft_links:",
        "  - target.md",
        "  - missing.md",
        "  - ../outside.md",
        "  - escaped-directory",
        "  - https://example.com/context",
        "---",
        "",
        "[Valid](target.md)",
        "[Missing](missing.md)",
        "[Lexical escape](../outside.md)",
        "[Symlink escape](escaped-directory)",
        "[Non-local](https://example.com/context)",
      ].join("\n"),
    );

    const findings = verifyTree(root).findings.filter((finding) => finding.path === "links.md");
    expect(findings.filter((finding) => finding.target === "target.md")).toEqual([]);
    expect(findings.filter((finding) => finding.target === "missing.md").map((finding) => finding.code)).toEqual([
      "TREE_SOFT_LINK_BROKEN",
    ]);
    expect(
      findings
        .filter((finding) => finding.target === "../outside.md")
        .map((finding) => finding.code)
        .sort(),
    ).toEqual(["TREE_SOFT_LINK_BROKEN", "TREE_SOFT_LINK_PATH_ESCAPE", "TREE_MARKDOWN_LINK_PATH_ESCAPE"].sort());
    expect(
      findings
        .filter((finding) => finding.target === "escaped-directory")
        .map((finding) => finding.code)
        .sort(),
    ).toEqual(["TREE_SOFT_LINK_PATH_ESCAPE", "TREE_MARKDOWN_LINK_PATH_ESCAPE"].sort());
    expect(
      findings.filter((finding) => finding.target === "https://example.com/context").map((finding) => finding.code),
    ).toEqual(["TREE_SOFT_LINK_BROKEN"]);
  });

  it("rejects invalid root manifest fields and root-only fields on domain nodes", () => {
    const root = validTree();
    writeFileSync(join(root, "NODE.md"), '---\nschemaVersion: 2\ntitle: "Root"\n---\n\n# Root\n');
    writeFileSync(join(root, "domain.md"), '---\nschemaVersion: 1\ntitle: "Domain"\n---\n\n# Domain\n');
    const findings = verifyTree(root).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_ROOT_NODE_INVALID", path: "NODE.md" }),
        expect.objectContaining({ code: "TREE_ROOT_ONLY_FIELDS", path: "domain.md" }),
      ]),
    );
  });

  it("rejects invalid UTF-8 and all content symlinks", () => {
    const root = validTree();
    writeFileSync(join(root, "invalid.md"), Buffer.from([0xff, 0xfe]));
    const outside = join(tempRoot(), "outside.md");
    writeFileSync(outside, node("Outside"));
    symlinkSync(outside, join(root, "escape.md"));
    const outsideDirectory = join(tempRoot(), "outside-directory");
    mkdirSync(outsideDirectory);
    symlinkSync(outsideDirectory, join(root, "escape-directory"));
    mkdirSync(join(root, "members/alice"), { recursive: true });
    writeFileSync(join(root, "members/NODE.md"), node("Members"));
    writeFileSync(join(root, "members/alice/NODE.md"), node("Alice"));
    writeFileSync(join(root, "members/alice/memory.md"), node("Memory"));
    symlinkSync(join(root, "members/alice/memory.md"), join(root, "cross.md"));

    const codes = verifyTree(root).findings.map((finding) => finding.code);
    expect(codes).toContain("TREE_FRONTMATTER_PARSE");
    expect(codes.filter((code) => code === "TREE_SYMLINK_UNSUPPORTED")).toHaveLength(3);
  });

  it("rejects internal, dangling, and directory symlinks consistently", () => {
    const root = validTree();
    writeFileSync(join(root, "target.md"), node("Target"));
    symlinkSync(join(root, "target.md"), join(root, "regular.md"));
    symlinkSync(join(root, "missing.md"), join(root, "dangling.md"));
    mkdirSync(join(root, "directory"));
    writeFileSync(join(root, "directory/NODE.md"), node("Directory"));
    symlinkSync(join(root, "directory"), join(root, "linked-directory"));

    const findings = verifyTree(root).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_SYMLINK_UNSUPPORTED", path: "dangling.md" }),
        expect.objectContaining({ code: "TREE_SYMLINK_UNSUPPORTED", path: "linked-directory" }),
      ]),
    );
    expect(findings).toContainEqual(expect.objectContaining({ code: "TREE_SYMLINK_UNSUPPORTED", path: "regular.md" }));
  });

  it("requires NODE.md in normal and member directories", () => {
    const root = validTree();
    mkdirSync(join(root, "members/bob"), { recursive: true });
    writeFileSync(join(root, "members/bob/notes.md"), node("Notes"));
    const findings = verifyTree(root).findings;
    expect(findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ code: "TREE_DIRECTORY_NODE_MISSING", path: "members" }),
        expect.objectContaining({ code: "TREE_DIRECTORY_NODE_MISSING", path: "members/bob" }),
      ]),
    );
  });

  it("ignores repository infrastructure and treats raw-context as ordinary content", () => {
    const root = validTree();
    mkdirSync(join(root, ".github/unindexed"), { recursive: true });
    mkdirSync(join(root, "scripts/unindexed"), { recursive: true });
    mkdirSync(join(root, "raw-context/notes"), { recursive: true });
    writeFileSync(join(root, "raw-context/NODE.md"), node("Raw context"));
    writeFileSync(join(root, "raw-context/notes/evidence.md"), node("Evidence"));
    const findings = verifyTree(root).findings;
    expect(findings).toContainEqual(
      expect.objectContaining({ code: "TREE_DIRECTORY_NODE_MISSING", path: "raw-context/notes" }),
    );
    expect(findings.some((finding) => finding.path.includes(".github") || finding.path.includes("scripts"))).toBe(
      false,
    );
  });
});

describe("indexed reading", () => {
  it("returns a selected body and immediate child summaries", () => {
    const root = join(tempRoot(), "existing");
    cpSync(join(FIXTURES, "valid"), root, { recursive: true });

    const rootRead = readTree(root);
    expect(rootRead.node).toMatchObject({ body: expect.stringContaining("Canonical durable context"), path: "." });
    expect(rootRead.node.body).not.toContain("schemaVersion:");
    expect(rootRead.children.map((child) => child.path)).toEqual(["members", "overview.md", "product"]);
    expect(rootRead.children.map((child) => child.path)).not.toContain("product/runtime.md");

    expect(readTree(root, "members").children.map((child) => child.path)).toEqual(["members/alice"]);
    expect(readTree(root, "members/alice/memory.md").node).toMatchObject({
      body: expect.stringContaining("Agent-specific working context"),
      contentClass: "member",
      path: "members/alice/memory.md",
    });
    expect(readTree(root, "members/alice/memory.md").children).toEqual([]);
    expect(readTree(root)).toEqual(readTree(root, "NODE.md"));
    expect(readTree(root, "product")).toEqual(readTree(root, "product/NODE.md"));
  });

  it("retains complete metadata without expanding soft links", () => {
    const root = validTree();
    mkdirSync(join(root, "domain"));
    writeFileSync(
      join(root, "domain/NODE.md"),
      '---\ntitle: "Domain"\ndescription: "Summary"\nsoft_links: [target.md]\nextension: true\n---\n\n# Domain\n',
    );
    writeFileSync(join(root, "domain/target.md"), node("Target"));
    const result = readTree(root, "domain");
    expect(result.node.frontmatter).toEqual({
      description: "Summary",
      extension: true,
      soft_links: ["target.md"],
      title: "Domain",
    });
    expect(result.children.map((child) => child.path)).toEqual(["domain/target.md"]);
  });

  it("rejects infrastructure, unsafe, escaping, or missing targets", () => {
    const root = validTree();
    const outside = join(tempRoot(), "outside.md");
    writeFileSync(outside, node("Outside"));
    symlinkSync(outside, join(root, "escape.md"));
    expect(() => readTree(root, "escape.md")).toThrow(/real file/u);
    expect(() => readTree(root, "../outside")).toThrow(/outside/u);
    expect(() => readTree(root, "missing")).toThrow();
    expect(() => readTree(root, ".github")).toThrow(/infrastructure/u);
    expect(() => readTree(root, "scripts")).toThrow(/infrastructure/u);
  });
});

it("rejects a symlinked child index before reading its metadata", () => {
  const root = validTree();
  mkdirSync(join(root, "child"));
  const outside = join(tempRoot(), "private.md");
  writeFileSync(outside, node("Outside"));
  symlinkSync(outside, join(root, "child/NODE.md"));
  expect(() => readTree(root)).toThrow(/regular file/);
});
