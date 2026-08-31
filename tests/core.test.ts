import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type CommandRunner, pushTree } from "../src/core/push.js";
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "../src/index.js";
import { credentialFreeRepositoryUrlSchema } from "../src/schemas.js";

const FIXTURES = resolve(import.meta.dirname, "fixtures");
const EXAMPLES = resolve(import.meta.dirname, "../examples");
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
  scaffoldTree({ path: root, name: "context" });
  return root;
}

function node(title: string): string {
  return `---\ntitle: "${title}"\n---\n\n# ${title}\n`;
}

describe("schema version 1", () => {
  it("keeps the public repository URL contract provider-neutral and credential-free", () => {
    const validRepositories = [
      "http://git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git",
      "ssh://git@git.example.test/acme/tree.git",
      "git@git.example.test:acme/tree.git",
    ];
    for (const repository of validRepositories) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(true);
    }
    for (const repository of [
      "https://token@github.com/acme/tree.git",
      "http://user:secret@git.example.test/acme/tree.git",
      "https://github.com/acme/tree.git?token=secret",
    ]) {
      expect(credentialFreeRepositoryUrlSchema.safeParse(repository).success, repository).toBe(false);
    }
  });

  it("rejects missing or unsupported schemaVersion on the root node", () => {
    for (const frontmatter of ['title: "Root"', 'schemaVersion: 2\ntitle: "Root"']) {
      const root = validTree();
      writeFileSync(join(root, "NODE.md"), `---\n${frontmatter}\n---\n\n# Root\n`);
      expect(verifyTree(root).findings).toEqual([
        expect.objectContaining({ code: "TREE_ROOT_NODE_INVALID", path: "NODE.md" }),
      ]);
    }
  });
});

describe("verification", () => {
  it("ships a valid indexed example tree", () => {
    expect(verifyTree(join(EXAMPLES, "basic"))).toMatchObject({ findings: [], ok: true });
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
    expect(findings.filter((finding) => finding.target === "../outside.md").map((finding) => finding.code)).toEqual([
      "TREE_SOFT_LINK_BROKEN",
      "TREE_SOFT_LINK_PATH_ESCAPE",
      "TREE_MARKDOWN_LINK_PATH_ESCAPE",
    ]);
    expect(findings.filter((finding) => finding.target === "escaped-directory").map((finding) => finding.code)).toEqual(
      ["TREE_SOFT_LINK_PATH_ESCAPE", "TREE_MARKDOWN_LINK_PATH_ESCAPE"],
    );
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

  it("rejects invalid UTF-8 and symlinks that escape or cross content classes", () => {
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
    expect(codes).toContain("TREE_MARKDOWN_FILE_PATH_ESCAPE");
    expect(codes).toContain("TREE_MARKDOWN_FILE_CONTENT_CLASS_MISMATCH");
    expect(codes).toContain("TREE_DIRECTORY_SYMLINK_PATH_ESCAPE");
  });

  it("accepts safe file symlinks and rejects dangling or unsupported symlinks", () => {
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
        expect.objectContaining({ code: "TREE_MARKDOWN_FILE_SYMLINK_BROKEN", path: "dangling.md" }),
        expect.objectContaining({ code: "TREE_DIRECTORY_SYMLINK_UNSUPPORTED", path: "linked-directory" }),
      ]),
    );
    expect(findings.some((finding) => finding.path === "regular.md")).toBe(false);
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
    expect(rootRead.children.map((child) => child.path)).toEqual(["members", "opentag.md", "product"]);
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

describe("scaffold and policy", () => {
  it("packages the agent instructions with their exact filename", () => {
    expect(readdirSync(resolve(import.meta.dirname, "../templates"))).toContain("AGENTS.md");
    expect(readdirSync(resolve(import.meta.dirname, "../templates"))).not.toContain("agents.md");
  });

  it("includes version-pinned GitHub validation for the authoritative default branch", () => {
    const root = validTree();
    const workflow = readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8");
    expect(workflow).toContain('branches: ["trunk"]');
    expect(workflow).toContain("@first-tree-ai/context-tree@0.1.5 verify");
    expect(existsSync(join(root, ".github/workflows/validate-context-tree.yml"))).toBe(true);
    expect(readFileSync(join(root, "NODE.md"), "utf8")).not.toContain("owners:");
  });

  it("includes agent instructions describing the tree purpose and structure", () => {
    const root = validTree();
    const instructions = readFileSync(join(root, "AGENTS.md"), "utf8");
    expect(instructions).toContain("durable shared memory for agents");
    expect(instructions).toContain("not a source-code mirror, wiki dump, or task log");
    expect(instructions).toContain("Each content directory is a domain and has a `NODE.md` index");
    expect(instructions).toContain("Would it remain true if the triggering work were redone?");
    expect(instructions).toContain("Run `context-tree verify` before committing");
    expect(lstatSync(join(root, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });

  it("rejects malformed tree names", () => {
    const base = { path: join(tempRoot(), "tree") };
    for (const name of ["acme/context", "context.git", ".", "..", ".hidden", " context", "a/b/c"]) {
      expect(() => scaffoldTree({ ...base, name }), name).toThrow();
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
    const options = { name: "context" };
    expect(() => scaffoldTree({ ...options, path: linkedDirectory })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: danglingLink })).toThrow(/symlink or non-directory/u);
    expect(() => scaffoldTree({ ...options, path: file })).toThrow(/symlink or non-directory/u);
  });

  it("commits the verified scaffold without configuring an origin", () => {
    const root = join(tempRoot(), "committed");
    const result = scaffoldTree({ path: root, name: "context" });
    expect(result.branch).toBe("trunk");
    expect(result.commit).toMatch(/^[0-9a-f]{40}$/u);
    const status = spawnSync("git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], {
      encoding: "utf8",
    });
    expect(status.stdout).toBe("");
    const head = spawnSync("git", ["-C", root, "rev-parse", "HEAD"], { encoding: "utf8" });
    expect(head.stdout.trim()).toBe(result.commit);
    const remotes = spawnSync("git", ["-C", root, "remote"], { encoding: "utf8" });
    expect(remotes.stdout).toBe("");
    const message = spawnSync("git", ["-C", root, "log", "-1", "--format=%s"], { encoding: "utf8" });
    expect(message.stdout).toBe("Initialize Context Tree\n");
  });

  it("uses Git's effective default branch and initializes the repository", () => {
    const root = validTree();
    expect(existsSync(join(root, ".git"))).toBe(true);
    expect(readFileSync(join(root, ".git/HEAD"), "utf8")).toBe("ref: refs/heads/trunk\n");
    expect(readFileSync(join(root, ".github/workflows/validate-context-tree.yml"), "utf8")).toContain(
      'branches: ["trunk"]',
    );
  });

  it("fails without Git and writes no scaffold files", () => {
    const root = join(tempRoot(), "missing-git");
    const originalPath = process.env.PATH;
    process.env.PATH = tempRoot();
    try {
      expect(() => scaffoldTree({ path: root, name: "context" })).toThrow(/initialize Git repository/u);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }
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

  it("treats owners as inert unknown metadata", () => {
    const root = validTree();
    writeFileSync(join(root, "legacy.md"), '---\ntitle: "Legacy metadata"\nowners: false\n---\n');
    expect(verifyTree(root)).toMatchObject({ findings: [], ok: true });
  });
});

describe("push", () => {
  type Script = (command: string, args: string[]) => { status?: number; stderr?: string; stdout?: string } | undefined;

  function scriptedRunner(script: Script, log: string[][] = []): CommandRunner {
    return (command, args) => {
      log.push([command, ...args]);
      const response = script(command, args);
      return { status: response?.status ?? 0, stderr: response?.stderr ?? "", stdout: response?.stdout ?? "" };
    };
  }

  function pushError(run: () => unknown): { code: string | undefined; message: string } {
    try {
      run();
    } catch (error) {
      return { code: (error as { code?: string }).code, message: (error as Error).message };
    }
    throw new Error("Expected push to fail.");
  }

  function scaffold(): string {
    const root = join(tempRoot(), "push-tree");
    return scaffoldTree({ path: root, name: "context" }).root;
  }

  function originRunner(origin: string | undefined, log: string[][]): CommandRunner {
    return scriptedRunner((command, args) => {
      if (command === "git" && args[2] === "symbolic-ref") return { stdout: "trunk" };
      if (command === "git" && args[2] === "rev-parse") return { stdout: "a".repeat(40) };
      if (command === "git" && args[2] === "status") return { stdout: "?? notes.md\n" };
      if (command === "git" && args[2] === "remote" && args[3] === "get-url") {
        return origin === undefined ? { status: 1 } : { stdout: origin };
      }
      if (command === "git" && args[2] === "ls-remote") return { stdout: "ref: refs/heads/main\tHEAD\n" };
      return undefined;
    }, log);
  }

  it("refuses to push commits before they exist", () => {
    const root = scaffold();
    const log: string[][] = [];
    const runner = scriptedRunner((command, args) => {
      if (command === "git" && args[2] === "symbolic-ref") return { stdout: "trunk" };
      if (command === "git" && args[2] === "rev-parse") return { status: 1 };
      return undefined;
    }, log);
    const failure = pushError(() => pushTree({ path: root }, runner));
    expect(failure.code).toBe("NO_COMMITS");
  });

  it("creates a private repository, configures origin, pushes, and sets the default branch", () => {
    const root = scaffold();
    const log: string[][] = [];
    const result = pushTree({ path: root, repository: "acme/context" }, originRunner(undefined, log));
    expect(result).toEqual({
      branch: "trunk",
      defaultBranch: "trunk",
      remote: {
        name: "origin",
        repository: "acme/context",
        url: "https://github.com/acme/context.git",
      },
      root: realpathSync(root),
      schemaVersion: 1,
      sha: "a".repeat(40),
      uncommittedFiles: 1,
    });
    expect(log).toContainEqual(["gh", "repo", "create", "acme/context", "--private"]);
    expect(log).toContainEqual([
      "git",
      "-C",
      realpathSync(root),
      "remote",
      "add",
      "origin",
      "https://github.com/acme/context.git",
    ]);
    expect(log).toContainEqual(["git", "-C", realpathSync(root), "push", "--set-upstream", "origin", "trunk"]);
    expect(log).toContainEqual(["gh", "repo", "edit", "acme/context", "--default-branch", "trunk"]);
  });

  it("pushes to an existing origin and discovers its default branch", () => {
    const root = scaffold();
    const log: string[][] = [];
    const result = pushTree({ path: root }, originRunner("https://github.com/acme/context.git", log));
    expect(result.remote).toEqual({
      name: "origin",
      repository: "acme/context",
      url: "https://github.com/acme/context.git",
    });
    expect(result.defaultBranch).toBe("main");
    expect(log.some(([command, ...args]) => command === "gh" && args.join(" ").includes("repo create"))).toBe(false);
  });

  it("rejects pushing without an origin and without an owner/repository", () => {
    const root = scaffold();
    const failure = pushError(() => pushTree({ path: root }, originRunner(undefined, [])));
    expect(failure.code).toBe("NO_REMOTE");
  });

  it("rejects an owner/repository that differs from the existing origin", () => {
    const root = scaffold();
    const failure = pushError(() =>
      pushTree({ path: root, repository: "acme/other" }, originRunner("https://github.com/acme/context.git", [])),
    );
    expect(failure.message).toContain("different repository");
  });

  it("surfaces GitHub creation failures with their stderr", () => {
    const root = scaffold();
    const runner = scriptedRunner((command, args) => {
      if (command === "git" && args[2] === "symbolic-ref") return { stdout: "trunk" };
      if (command === "git" && args[2] === "rev-parse") return { stdout: "a".repeat(40) };
      if (command === "git" && args[2] === "status") return { stdout: "" };
      if (command === "git" && args[2] === "remote" && args[3] === "get-url") return { status: 1 };
      if (command === "gh") return { status: 1, stderr: "name already exists on this account" };
      return undefined;
    });
    const failure = pushError(() => pushTree({ path: root, repository: "acme/context" }, runner));
    expect(failure.message).toContain("name already exists on this account");
  });
});
