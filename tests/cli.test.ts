import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  contextTreeCliErrorEnvelopeSchema,
  contextTreeReadResultSchema,
  managedTreeListingResultSchema,
  verifyTreeReportSchema,
} from "../src/schemas.js";

const CLI = resolve(import.meta.dirname, "../dist/cli/index.mjs");
const PACKAGE_VERSION = JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")).version;
const workspaces = new Set<string>();

type CliResult = { status: number | null; stderr: string; stdout: string };

function expectCliError(result: CliResult, code: string): ReturnType<typeof contextTreeCliErrorEnvelopeSchema.parse> {
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  const envelope = contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(result.stdout));
  expect(envelope.error.code).toBe(code);
  return envelope;
}

function expectCliTextError(result: CliResult, fragment: string): void {
  expect(result.status).toBe(1);
  expect(result.stdout).toBe("");
  expect(result.stderr).toContain("context-tree:");
  expect(result.stderr).toContain(fragment);
}

function workspace(): string {
  const path = mkdtempSync(resolve(tmpdir(), "context-tree-cli-"));
  workspaces.add(path);
  writeFileSync(
    resolve(path, "gitconfig"),
    "[init]\n\tdefaultBranch = trunk\n[user]\n\tname = Test\n\temail = test@example.test\n",
  );
  return path;
}

afterEach(() => {
  for (const path of workspaces) rmSync(path, { force: true, recursive: true });
  workspaces.clear();
});

function cli(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  connectionHome: string = cwd,
): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...environment,
      GIT_CONFIG_GLOBAL: resolve(connectionHome, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: connectionHome,
    },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function git(cwd: string, args: string[], connectionHome: string): void {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: resolve(connectionHome, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: connectionHome,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

type CreateResult = {
  branch: string;
  commitSha: string;
  created: boolean;
  schemaVersion: 1;
  title: string;
  treePath: string;
};

/** Set up one managed tree for a project through the CLI and return the parsed result. */
function create(root: string, project: string): CreateResult {
  const result = cli(project, ["create", "--json"], undefined, root);
  expect(result.status).toBe(0);
  return JSON.parse(result.stdout) as CreateResult;
}

function createExpectation(root: string, result: CreateResult, expectedName: string): void {
  const managed = realpathSync(join(root, ".context-tree", "trees"));
  expect(result.created).toBe(true);
  expect(result.title).toBe(expectedName);
  expect(result.treePath).toBe(join(managed, expectedName));
  expect(result.branch).toBe("trunk");
  expect(result.commitSha).toMatch(/^[0-9a-f]{40}$/u);
  expect(existsSync(join(result.treePath, "NODE.md"))).toBe(true);
}

describe("built CLI", () => {
  it("exposes the lifecycle commands", () => {
    const help = cli(workspace(), ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Create, connect, list, read, write, and publish Context Trees.");
    expect([...help.stdout.matchAll(/^ {2}([a-z][\w-]*)\s+/gmu)].map((match) => match[1]).sort()).toEqual([
      "connect",
      "create",
      "finish-write",
      "install",
      "list",
      "prepare-write",
      "publish",
      "read",
      "resolve",
      "sync",
      "verify",
    ]);
    const version = cli(workspace(), ["--version"]);
    expect(version).toMatchObject({ status: 0, stderr: "", stdout: `${PACKAGE_VERSION}\n` });
  });

  it("sets up, resolves, verifies, and reads with versioned JSON", () => {
    const root = workspace();
    const project = join(root, "My Service!");
    mkdirSync(project, { recursive: true });
    const created = JSON.parse(cli(project, ["create", "--json"], undefined, root).stdout) as CreateResult;
    expect(created.created).toBe(true);
    expect(created.title).toBe("my-service-context-tree");
    expect(created.treePath).toBe(join(realpathSync(root), ".context-tree", "trees", "my-service-context-tree"));
    expect(created.branch).toBe("trunk");
    expect(created.commitSha).toMatch(/^[0-9a-f]{40}$/u);
    expect(existsSync(join(created.treePath, "NODE.md"))).toBe(true);

    const resolved = JSON.parse(cli(project, ["resolve", "--json"], undefined, root).stdout);
    expect(resolved).toEqual({ schemaVersion: 1, tree: { kind: "local", path: created.treePath } });

    const verify = JSON.parse(cli(project, ["verify", "--tree-path", created.treePath, "--json"], undefined, root).stdout);
    expect(verifyTreeReportSchema.parse(verify)).toMatchObject({ ok: true });

    const read = JSON.parse(cli(project, ["read", "--tree-path", created.treePath, "--json"], undefined, root).stdout);
    expect(contextTreeReadResultSchema.parse(read)).toMatchObject({ target: "." });
  });

  it("records the tree in the project's own AGENTS.md", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = JSON.parse(cli(project, ["create", "--json"], undefined, root).stdout) as CreateResult & {
      pointer: string;
    };
    expect(created.pointer).toBe("written");
    const instructions = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(instructions).toContain("<!-- context-tree:begin -->");
    expect(instructions).toContain(created.treePath);
    expect(instructions).toContain("<!-- context-tree:end -->");

    // Reconnecting the same tree rewrites the single block rather than appending another.
    const reconnected = JSON.parse(cli(project, ["connect", "service-context-tree", "--json"], undefined, root).stdout) as {
      pointer: string;
    };
    expect(reconnected.pointer).toBe("skipped");
    const after = readFileSync(join(project, "AGENTS.md"), "utf8");
    expect(after.match(/context-tree:begin/gu)).toHaveLength(1);
  });

  it("installs the packaged skills into a named project directory", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const result = JSON.parse(
      cli(project, ["install", "--host", "claude", "--project", project], undefined, root).stdout,
    );
    expect(result.schemaVersion).toBe(1);
    expect(result.version).toBe(PACKAGE_VERSION);
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0].host).toBe("claude");
    expect(result.installed[0].skills).toEqual([
      "context-tree-connect",
      "context-tree-create",
      "context-tree-publish",
      "context-tree-read",
      "context-tree-setup",
      "context-tree-write",
    ]);
    const installed = join(project, ".claude", "skills", "context-tree-read", "SKILL.md");
    expect(existsSync(installed)).toBe(true);
    expect(readFileSync(installed, "utf8")).toContain("context-tree sync");
    // Codex interface metadata travels with the skill.
    expect(existsSync(join(project, ".claude", "skills", "context-tree-read", "agents", "openai.yaml"))).toBe(true);
  });

  it("skips absent hosts on a home install rather than creating their directories", () => {
    const root = workspace();
    const result = JSON.parse(cli(root, ["install"], undefined, root).stdout);
    expect(result.installed).toEqual([]);
    expect(result.skipped.map((entry: { host: string }) => entry.host).sort()).toEqual(["claude", "codex"]);
    expect(existsSync(join(root, ".claude"))).toBe(false);
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  it("installs into a host directory the user already has", () => {
    const root = workspace();
    mkdirSync(join(root, ".claude"));
    const result = JSON.parse(cli(root, ["install"], undefined, root).stdout);
    expect(result.installed.map((entry: { host: string }) => entry.host)).toEqual(["claude"]);
    expect(result.skipped.map((entry: { host: string }) => entry.host)).toEqual(["codex"]);
    expect(existsSync(join(root, ".claude", "skills", "context-tree-write", "SKILL.md"))).toBe(true);
    expect(existsSync(join(root, ".codex"))).toBe(false);
  });

  it("is idempotent for repeated create", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const first = create(root, project);
    const second = create(root, project);
    expect(second.created).toBe(false);
    expect(second.treePath).toBe(first.treePath);
    expect(second.commitSha).toBe(first.commitSha);
    expect(second.title).toBe(first.title);
  });

  it("sets up Git projects without an origin and resolves nested working directories", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    git(project, ["init", "--quiet"], root);
    const created = create(root, project);
    createExpectation(root, created, "service-context-tree");

    const nested = join(project, "deep", "nested");
    mkdirSync(nested, { recursive: true });
    expect(JSON.parse(cli(nested, ["resolve", "--json"], undefined, root).stdout)).toEqual({
      schemaVersion: 1,
      tree: { kind: "local", path: created.treePath },
    });
  });

  it("keeps separate clones and worktrees independent from the connected checkout", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    git(project, ["init", "--quiet"], root);
    const created = create(root, project);

    const clone = join(root, "clone");
    git(root, ["clone", "--quiet", project, clone], root);
    expectCliError(cli(clone, ["resolve", "--json"], undefined, root), "NO_CONNECTION");

    writeFileSync(join(project, "file.txt"), "content\n");
    git(project, ["add", "file.txt"], root);
    git(project, ["commit", "--quiet", "-m", "commit"], root);
    const worktree = join(root, "worktree");
    git(project, ["worktree", "add", "--quiet", worktree], root);
    expectCliError(cli(worktree, ["resolve", "--json"], undefined, root), "NO_CONNECTION");
    expect(JSON.parse(cli(project, ["resolve", "--json"], undefined, root).stdout)).toEqual({
      schemaVersion: 1,
      tree: { kind: "local", path: created.treePath },
    });
  });

  it("requires an exact connected directory for a non-Git project", () => {
    const root = workspace();
    const project = join(root, "notes");
    mkdirSync(project);
    create(root, project);
    const nested = join(project, "sub", "dir");
    mkdirSync(nested, { recursive: true });
    expectCliError(cli(nested, ["resolve", "--json"], undefined, root), "NO_CONNECTION");
  });

  it("connects a second project by exact managed name", () => {
    const root = workspace();
    const first = join(root, "first");
    mkdirSync(first);
    const created = create(root, first);
    const second = join(root, "second");
    mkdirSync(second);
    const connected = JSON.parse(cli(second, ["connect", "first-context-tree", "--json"], undefined, root).stdout);
    expect(connected).toEqual({
      pointer: "written",
      schemaVersion: 1,
      tree: { kind: "local", path: created.treePath },
    });
    expect(JSON.parse(cli(second, ["resolve", "--json"], undefined, root).stdout)).toEqual({
      schemaVersion: 1,
      tree: { kind: "local", path: created.treePath },
    });
  });

  it("lists managed trees with the public schema", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = create(root, project);
    const listing = JSON.parse(cli(project, ["list", "--json"], undefined, root).stdout);
    expect(managedTreeListingResultSchema.parse(listing)).toEqual({
      schemaVersion: 1,
      trees: [{ name: "service-context-tree", tree: { kind: "local", path: created.treePath } }],
    });
  });

  it("connects a disk tree in place with --tree-path", () => {
    const root = workspace();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const tree = create(root, first).treePath;
    const connected = JSON.parse(cli(second, ["connect", "--tree-path", tree, "--json"], undefined, root).stdout);
    expect(connected).toEqual({ pointer: "written", schemaVersion: 1, tree: { kind: "local", path: tree } });
    expect(JSON.parse(cli(second, ["resolve", "--json"], undefined, root).stdout).tree.path).toBe(tree);
  });

  it("rejects ambiguous disk-path connect syntax", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const tree = create(root, project).treePath;
    expectCliError(
      cli(project, ["connect", "service-context-tree", "--tree-path", tree, "--json"], undefined, root),
      "CONTEXT_TREE_FAILED",
    );
  });

  it("automatically switches an existing connection", () => {
    const root = workspace();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const firstTree = create(root, first).treePath;
    const secondTree = create(root, second).treePath;

    expect(JSON.parse(cli(first, ["resolve", "--json"], undefined, root).stdout).tree.path).toBe(firstTree);
    const replaced = JSON.parse(cli(first, ["connect", "second-context-tree", "--json"], undefined, root).stdout);
    expect(replaced.tree.path).toBe(secondTree);
  });

  it("rejects missing, unsafe, and removed connect arguments", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    create(root, project);
    expectCliError(cli(project, ["connect", "--json"], undefined, root), "CONTEXT_TREE_FAILED");
    expectCliError(cli(project, ["connect", "../unsafe", "--json"], undefined, root), "CONTEXT_TREE_FAILED");
    expectCliError(cli(project, ["connect", "MissingName", "--json"], undefined, root), "CONTEXT_TREE_FAILED");
    expectCliError(
      cli(project, ["connect", "service-context-tree", "--replace", "--json"], undefined, root),
      "CONTEXT_TREE_FAILED",
    );
  });

  it("reports missing, corrupt, dirty, and stale connections with strict envelopes", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    expectCliError(cli(project, ["resolve", "--json"], undefined, root), "NO_CONNECTION");
    expectCliError(cli(project, ["sync"], undefined, root), "NO_CONNECTION");
    expectCliError(cli(project, ["prepare-write"], undefined, root), "NO_CONNECTION");

    const created = create(root, project);
    const connectionPath = join(root, ".context-tree", "connections.json");
    const connection = JSON.parse(readFileSync(connectionPath, "utf8")).connections[0];
    writeFileSync(connectionPath, `${JSON.stringify({ connections: [connection, connection], schemaVersion: 1 })}\n`);
    expectCliError(cli(project, ["resolve", "--json"], undefined, root), "CORRUPT_CONNECTION");

    writeFileSync(connectionPath, "{not json");
    expectCliError(cli(project, ["resolve", "--json"], undefined, root), "CORRUPT_CONNECTION");

    rmSync(connectionPath);
    expect(cli(project, ["connect", "service-context-tree", "--json"], undefined, root).status).toBe(0);

    // An uncommitted edit is the user's own work in progress, not a broken connection.
    writeFileSync(join(created.treePath, "draft.md"), '---\ntitle: "Draft"\n---\n\n# Draft\n');
    const dirty = expectCliError(cli(project, ["resolve", "--json"], undefined, root), "DIRTY_TREE");
    expect(dirty.error.message).toContain("commit or discard");
    rmSync(join(created.treePath, "draft.md"));

    renameSync(created.treePath, `${created.treePath}-moved`);
    const stale = expectCliError(cli(project, ["resolve", "--json"], undefined, root), "STALE_CONNECTION");
    expect(stale.error.message).toContain("context-tree connect");
  });

  it("synchronizes local trees without the network and reports the exact commit", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = create(root, project);
    const synced = JSON.parse(cli(project, ["sync"], undefined, root).stdout);
    expect(synced).toEqual({
      branch: "trunk",
      schemaVersion: 1,
      sha: created.commitSha,
      tree: { kind: "local", path: created.treePath },
    });
  });

  it("runs the local write lifecycle through prepare-write and finish-write", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = create(root, project);

    const prepared = JSON.parse(cli(project, ["prepare-write"], undefined, root).stdout);
    expect(prepared).toEqual({ schemaVersion: 1, worktreePath: expect.any(String) });
    expect(existsSync(join(prepared.worktreePath, "NODE.md"))).toBe(true);

    const membersDir = join(prepared.worktreePath, "members", "engineer");
    mkdirSync(membersDir, { recursive: true });
    writeFileSync(join(prepared.worktreePath, "members", "NODE.md"), '---\ntitle: "Members"\n---\n\n# Members\n');
    writeFileSync(join(membersDir, "NODE.md"), '---\ntitle: "Engineer"\n---\n\n# Engineer\n');
    writeFileSync(join(membersDir, "memory.md"), '---\ntitle: "Memory"\n---\n\n# Memory\n');

    const finished = JSON.parse(
      cli(
        project,
        ["finish-write", "--worktree-path", prepared.worktreePath, "--message", "Write the decision"],
        undefined,
        root,
      ).stdout,
    );
    expect(finished).toMatchObject({ branch: "trunk", sha: expect.stringMatching(/^[0-9a-f]{40}$/u) });
    expect(existsSync(prepared.worktreePath)).toBe(false);
    expect(JSON.parse(cli(project, ["resolve", "--json"], undefined, root).stdout)).toEqual({
      schemaVersion: 1,
      tree: { kind: "local", path: created.treePath },
    });

    const verify = JSON.parse(cli(project, ["verify", "--tree-path", created.treePath, "--json"], undefined, root).stdout);
    expect(verify).toMatchObject({ ok: true });
    expect(existsSync(join(created.treePath, "members", "engineer", "memory.md"))).toBe(true);

    const second = JSON.parse(cli(project, ["prepare-write"], undefined, root).stdout);
    expectCliError(
      cli(project, ["finish-write", "--worktree-path", second.worktreePath, "--message", "empty"], undefined, root),
      "CONTEXT_TREE_FAILED",
    );
  });

  it("refuses a finish-write for a worktree outside the connected tree", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    create(root, project);
    const foreign = join(root, "foreign");
    mkdirSync(foreign);
    git(foreign, ["init", "--quiet"], root);
    expectCliError(
      cli(project, ["finish-write", "--worktree-path", foreign, "--message", "nope"], undefined, root),
      "CONTEXT_TREE_FAILED",
    );
  });

  it("reports GitHub authentication failures when publishing", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    create(root, project);
    // A fake gh earlier on PATH fails authentication deterministically.
    const bin = join(root, "bin");
    mkdirSync(bin);
    writeFileSync(join(bin, "gh"), "#!/bin/sh\necho 'gh auth login required' >&2\nexit 1\n");
    chmodSync(join(bin, "gh"), 0o755);
    const publish = cli(project, ["publish", "--json"], { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, root);
    expectCliError(publish, "GITHUB_AUTH");
  });

  it("requires a connection for write operations on unconnected projects", () => {
    const root = workspace();
    const project = join(root, "unconnected");
    mkdirSync(project);
    expectCliError(cli(project, ["prepare-write"], undefined, root), "NO_CONNECTION");
  });

  it("rejects invalid trees before reading and before connecting", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = create(root, project);
    writeFileSync(join(created.treePath, "NODE.md"), '---\nschemaVersion: 1\ntitle: "Broken"\n---\n');
    git(created.treePath, ["add", "NODE.md"], root);
    git(created.treePath, ["commit", "--quiet", "-m", "break"], root);
    const read = cli(project, ["read", "--tree-path", created.treePath, "--json"], undefined, root);
    expect(expectCliError(read, "INVALID_TREE").error.message).toContain("context-tree verify");
    expectCliError(cli(project, ["connect", "service-context-tree", "--json"], undefined, root), "INVALID_TREE");
  });

  it("refuses to create a second tree for an already connected project", () => {
    const root = workspace();
    const first = join(root, "first");
    const second = join(root, "second");
    mkdirSync(first);
    mkdirSync(second);
    const shared = create(root, first).treePath;
    expect(cli(second, ["connect", "--tree-path", shared, "--json"], undefined, root).status).toBe(0);
    const failure = expectCliError(cli(second, ["create", "--json"], undefined, root), "CONTEXT_TREE_FAILED");
    expect(failure.error.message).toContain("already connected");
    expect(JSON.parse(cli(second, ["resolve", "--json"], undefined, root).stdout).tree.path).toBe(shared);
  });

  it("prints human-readable text by default for the inspection commands", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    const created = create(root, project);

    const resolved = cli(project, ["resolve"], undefined, root);
    expect(resolved.status).toBe(0);
    expect(resolved.stderr).toBe("");
    expect(resolved.stdout).toContain("Connected local Context Tree.");
    expect(resolved.stdout).toContain(created.treePath);

    const verify = cli(project, ["verify", "--tree-path", created.treePath], undefined, root);
    expect(verify.stdout).toContain("Context Tree OK.");
    expect(verify.stdout).not.toContain('"schemaVersion"');

    const read = cli(project, ["read", "--tree-path", created.treePath], undefined, root);
    expect(read.stdout).toContain("Path: .");
    expect(read.stdout).toContain(`Root: ${created.treePath}`);

    const listing = cli(project, ["list"], undefined, root);
    expect(listing.stdout).toContain("managed Context Tree");
    expect(listing.stdout).toContain("service-context-tree");
  });

  it("reports a text-mode failure on stderr with a non-zero exit code", () => {
    const root = workspace();
    const project = join(root, "service");
    mkdirSync(project);
    expectCliTextError(cli(project, ["resolve"], undefined, root), "No Context Tree connection exists");
  });
});
