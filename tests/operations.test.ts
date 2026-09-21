import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  connectProject,
  disconnectProject,
  listManagedTrees,
  managedTreesRoot,
  resolveConnection,
} from "../src/core/connections.js";
import { createProject } from "../src/core/create.js";
import { type CommandRunner, defaultRunner } from "../src/core/internal/git.js";
import { publishProject } from "../src/core/publish.js";
import { readTree } from "../src/core/read.js";
import { scaffoldTree } from "../src/core/scaffold.js";
import { syncConnection, syncProject } from "../src/core/sync.js";
import { finishContextWrite, prepareContextWrite } from "../src/core/write.js";

const roots = new Set<string>();
const originalHome = process.env.HOME;
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

function temporaryRoot(): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "context-tree-operations-")));
  roots.add(root);
  return root;
}

beforeEach(() => {
  const home = temporaryRoot();
  const config = join(home, "gitconfig");
  writeFileSync(config, "[init]\n\tdefaultBranch = trunk\n[user]\n\tname = Test\n\temail = test@example.test\n");
  process.env.HOME = home;
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

afterEach(() => {
  if (originalHome === undefined) delete process.env.HOME;
  else process.env.HOME = originalHome;
  if (originalGitConfigGlobal === undefined) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem;
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8" });
  if (result.status !== 0) throw new Error(result.stderr);
  return result.stdout.trim();
}

function project(name = "service"): string {
  const path = join(temporaryRoot(), name);
  mkdirSync(path);
  return path;
}

function addLeaf(root: string, name: string): void {
  writeFileSync(join(root, `${name}.md`), `---\ntitle: "${name}"\n---\n\n# ${name}\n`);
}

/** Age a prepared worktree past the abandonment threshold. */
function backdate(path: string): void {
  const past = Date.now() / 1000 - 48 * 60 * 60;
  utimesSync(path, past, past);
}

function writeBranches(treePath: string): string {
  return git(treePath, ["for-each-ref", "--format=%(refname:short)", "refs/heads/context-tree/write/"]);
}

function githubRunner(remote: string, log: string[][] = []): CommandRunner {
  return (command, args) => {
    log.push([command, ...args]);
    if (command === "git" && args.slice(-3).join(" ") === "remote get-url origin") {
      const actual = defaultRunner(command, args);
      return actual.status === 0 ? { status: 0, stderr: "", stdout: "https://github.com/acme/context.git\n" } : actual;
    }
    if (command === "git" && args.includes("clone")) {
      return defaultRunner(
        command,
        args.map((arg) => (arg === "https://github.com/acme/context.git" ? remote : arg)),
      );
    }
    return defaultRunner(command, args);
  };
}

function bareTree(): { remote: string; seed: string } {
  const root = temporaryRoot();
  const seed = join(root, "seed");
  scaffoldTree({ name: "context", path: seed });
  const remote = join(root, "remote.git");
  git(root, ["init", "--quiet", "--bare", remote]);
  git(seed, ["push", "--quiet", remote, "trunk"]);
  return { remote, seed };
}

describe("local lifecycle", () => {
  it("runs create, resolve, sync, prepare, edit, finish, and read", () => {
    const currentProject = project();
    const initialized = createProject(currentProject);
    expect(resolveConnection(currentProject).connections[0]?.tree).toEqual({
      kind: "local",
      path: initialized.treePath,
    });
    expect(syncProject(currentProject)).toMatchObject({
      connections: [{ ok: true, branch: "trunk", tree: { kind: "local" } }],
    });

    const prepared = prepareContextWrite(currentProject);
    expect(prepared).toMatchObject({
      connection: expect.any(Object),
      schemaVersion: 2,
      worktreePath: expect.any(String),
    });
    addLeaf(prepared.worktreePath, "runtime");
    const finished = finishContextWrite({
      message: "Write runtime context",
      projectPath: currentProject,
      worktreePath: prepared.worktreePath,
    });
    expect(finished).toMatchObject({ branch: "trunk", schemaVersion: 1, sha: expect.stringMatching(/^[a-f\d]{40}$/u) });
    expect(existsSync(prepared.worktreePath)).toBe(false);
    expect(readTree(initialized.treePath, "runtime.md").node.body).toContain("# runtime");
  });

  it("is idempotent and additively connects managed local connections", () => {
    const currentProject = project();
    const first = createProject(currentProject);
    expect(createProject(currentProject)).toMatchObject({ created: false, treePath: first.treePath });
    const otherProject = project("other");
    const other = createProject(otherProject).treePath;
    expect(connectProject({ projectPath: currentProject, target: "other-context-tree" }).tree).toEqual({
      kind: "local",
      path: realpathSync(other),
    });
  });

  it("treats duplicate project records as CORRUPT_CONNECTION", () => {
    const currentProject = realpathSync(project());
    const initialized = createProject(currentProject);
    const record = { projectPath: currentProject, tree: { kind: "local", path: initialized.treePath } } as const;
    writeFileSync(
      join(process.env.HOME ?? "", ".context-tree", "connections.json"),
      `${JSON.stringify({ connections: [record, record], schemaVersion: 2 })}\n`,
    );
    expect(() => resolveConnection(currentProject)).toThrow(expect.objectContaining({ code: "CORRUPT_CONNECTION" }));
  });

  it("removes newly created tree files after a partial create failure", () => {
    const currentProject = project();
    const runner: CommandRunner = (command, args) => {
      if (command === "git" && args.includes("commit")) return { status: 1, stderr: "commit failed", stdout: "" };
      return defaultRunner(command, args);
    };
    expect(() => createProject(currentProject, runner)).toThrow(/commit failed/u);
    const trees = join(process.env.HOME ?? "", ".context-tree", "trees");
    expect(readdirSync(trees)).toEqual([]);
  });

  it("rejects an occupied create name until the project explicitly connects to it", () => {
    const first = project("service");
    const tree = createProject(first);
    const second = project("service");
    expect(() => createProject(second)).toThrow(/connect service-context-tree/u);
    connectProject({ projectPath: second, target: "service-context-tree" });
    expect(createProject(second)).toMatchObject({ created: false, treePath: tree.treePath });
  });
});

describe("managed tree listing", () => {
  it("returns an empty list without creating the managed directory", () => {
    expect(listManagedTrees()).toEqual({ schemaVersion: 1, trees: [] });
    expect(existsSync(join(process.env.HOME ?? "", ".context-tree", "trees"))).toBe(false);
  });

  it("excludes unsafe, invalid, and symlinked candidates from the listing", () => {
    const currentProject = project();
    const tree = createProject(currentProject);

    const unsafe = join(managedTreesRoot(), "unsafe");
    scaffoldTree({ name: "unsafe", path: unsafe });
    git(unsafe, ["remote", "add", "origin", "https://token@github.com/acme/unsafe.git"]);

    const invalid = join(managedTreesRoot(), "invalid");
    scaffoldTree({ name: "invalid", path: invalid });
    writeFileSync(join(invalid, "NODE.md"), '---\nschemaVersion: 1\ntitle: "Broken"\n---\n');
    git(invalid, ["add", "--all"]);
    git(invalid, ["commit", "--quiet", "-m", "break"]);

    const outside = join(temporaryRoot(), "outside");
    scaffoldTree({ name: "outside", path: outside });
    symlinkSync(outside, join(managedTreesRoot(), "alias"), "dir");

    expect(listManagedTrees()).toEqual({
      schemaVersion: 1,
      trees: [{ name: "service-context-tree", tree: { kind: "local", path: tree.treePath } }],
    });
  });
});

describe("disk-path connections", () => {
  it("connects a GitHub-backed disk tree in place and persists it", () => {
    const { remote } = bareTree();
    const currentProject = project();
    const runner = githubRunner(remote, []);
    const checkout = join(temporaryRoot(), "checkout");
    git(temporaryRoot(), ["clone", "--quiet", remote, checkout]);
    const connected = connectProject({ projectPath: currentProject, treePath: checkout }, runner);
    expect(connected.tree).toEqual({
      kind: "github",
      path: realpathSync(checkout),
      repository: "acme/context",
    });
    expect(resolveConnection(currentProject).connections[0]?.tree).toEqual(connected.tree);
  });

  it("rejects symlinked and unsafe-origin disk paths", () => {
    const root = temporaryRoot();
    const currentProject = project();
    const outside = join(root, "outside");
    scaffoldTree({ name: "outside", path: outside });
    symlinkSync(outside, join(root, "alias"), "dir");
    expect(() => connectProject({ projectPath: currentProject, treePath: join(root, "alias") })).toThrow(
      /symlink component/u,
    );
    git(outside, ["remote", "add", "origin", "https://token@github.com/acme/outside.git"]);
    expect(() => connectProject({ projectPath: currentProject, treePath: outside })).toThrow(/credential-free/u);
  });
});

describe("abandoned write reclamation", () => {
  it("reclaims a stale preparation that was never edited", () => {
    const currentProject = project();
    const treePath = createProject(currentProject).treePath;
    const abandoned = prepareContextWrite(currentProject);
    expect(writeBranches(treePath)).not.toBe("");

    backdate(abandoned.worktreePath);
    const current = prepareContextWrite(currentProject);
    expect(existsSync(abandoned.worktreePath)).toBe(false);
    expect(writeBranches(treePath).split("\n")).toEqual([`context-tree/write/${basename(current.worktreePath)}`]);

    // Reclamation stays invisible in the contract and leaves the new write usable.
    expect(current).toMatchObject({
      connection: expect.any(Object),
      schemaVersion: 2,
      worktreePath: expect.any(String),
    });
    addLeaf(current.worktreePath, "survivor");
    expect(
      finishContextWrite({
        message: "Write after reclamation",
        projectPath: currentProject,
        worktreePath: current.worktreePath,
      }),
    ).toMatchObject({ branch: "trunk" });
  });

  it("preserves a stale preparation that holds pending edits", () => {
    const currentProject = project();
    createProject(currentProject);
    const editing = prepareContextWrite(currentProject);
    addLeaf(editing.worktreePath, "in-progress");
    backdate(editing.worktreePath);

    prepareContextWrite(currentProject);
    expect(existsSync(join(editing.worktreePath, "in-progress.md"))).toBe(true);
  });

  it("preserves a fresh preparation so concurrent writes survive", () => {
    const currentProject = project();
    const treePath = createProject(currentProject).treePath;
    const concurrent = prepareContextWrite(currentProject);

    prepareContextWrite(currentProject);
    expect(existsSync(concurrent.worktreePath)).toBe(true);
    expect(writeBranches(treePath).split("\n")).toHaveLength(2);
  });
});

describe("GitHub lifecycle", () => {
  it("clones, syncs the checked-out branch, and pushes one direct write", () => {
    const { remote } = bareTree();
    const currentProject = project();
    const log: string[][] = [];
    const runner = githubRunner(remote, log);
    const connected = connectProject({ projectPath: currentProject, target: "acme/context" }, runner);
    expect(connected.tree).toMatchObject({ kind: "github", repository: "acme/context" });
    // An identical reconnect is idempotent, without changing project instructions.
    expect(connectProject({ projectPath: currentProject, target: "acme/context" }, runner)).toEqual({
      ...connected,
    });
    expect(syncConnection(currentProject, runner).branch).toBe("trunk");
    const prepared = prepareContextWrite(currentProject, runner);
    addLeaf(prepared.worktreePath, "published");
    const finished = finishContextWrite(
      { message: "Write published context", projectPath: currentProject, worktreePath: prepared.worktreePath },
      runner,
    );
    expect(finished.branch).toBe("trunk");
    expect(git(remote, ["rev-parse", "refs/heads/trunk"])).toBe(finished.sha);
    expect(log).toContainEqual(["git", "-C", connected.tree.path, "pull", "--ff-only", "origin", "trunk"]);
    expect(log).toContainEqual([
      "git",
      "-C",
      prepared.worktreePath,
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Write published context",
    ]);
    expect(log).toContainEqual(["git", "-C", prepared.worktreePath, "push", "origin", "HEAD:refs/heads/trunk"]);
    expect(log.flat()).not.toContain("--force");
  });

  it("returns WRITE_OUTDATED and preserves a rejected worktree", () => {
    const { remote } = bareTree();
    const currentProject = project();
    const runner = githubRunner(remote);
    connectProject({ projectPath: currentProject, target: "acme/context" }, runner);
    const prepared = prepareContextWrite(currentProject, runner);
    addLeaf(prepared.worktreePath, "outdated");

    const peer = join(temporaryRoot(), "peer");
    git(temporaryRoot(), ["clone", "--quiet", remote, peer]);
    addLeaf(peer, "concurrent");
    git(peer, ["add", "--all"]);
    git(peer, ["commit", "--quiet", "-m", "Concurrent"]);
    git(peer, ["push", "--quiet", "origin", "trunk"]);

    expect(() =>
      finishContextWrite(
        { message: "Write outdated context", projectPath: currentProject, worktreePath: prepared.worktreePath },
        runner,
      ),
    ).toThrow(expect.objectContaining({ code: "WRITE_OUTDATED" }));
    expect(existsSync(prepared.worktreePath)).toBe(true);

    // Its commit is unmerged, so reclamation must leave it alone however stale it looks.
    backdate(prepared.worktreePath);
    const retry = prepareContextWrite(currentProject, runner);
    expect(existsSync(prepared.worktreePath)).toBe(true);
    expect(retry.worktreePath).not.toBe(prepared.worktreePath);
  });

  it("rejects a foreign prepared worktree", () => {
    const first = project("first");
    const second = project("second");
    createProject(first);
    createProject(second);
    const foreign = prepareContextWrite(second);
    addLeaf(foreign.worktreePath, "foreign");
    expect(() =>
      finishContextWrite({ message: "Foreign", projectPath: first, worktreePath: foreign.worktreePath }),
    ).toThrow(/No connection named|removed or replaced/u);
  });

  it("allocates a GitHub checkout without colliding with a local tree", () => {
    const currentProject = project();
    const local = createProject(currentProject);
    const occupied = join(managedTreesRoot(), "context");
    scaffoldTree({ name: "context", path: occupied });
    const { remote } = bareTree();
    const runner = githubRunner(remote);
    const connected = connectProject({ projectPath: currentProject, target: "acme/context" }, runner);
    expect(connected.tree.path).not.toBe(occupied);
    expect(existsSync(local.treePath)).toBe(true);
    expect(connectProject({ projectPath: currentProject, target: "acme/context" }, runner).tree.path).toBe(
      connected.tree.path,
    );
  });

  it("rejects unsafe origins and symlinked managed names", () => {
    const currentProject = project();
    const unsafe = join(managedTreesRoot(), "unsafe");
    scaffoldTree({ name: "unsafe", path: unsafe });
    git(unsafe, ["remote", "add", "origin", "https://token@github.com/acme/unsafe.git"]);
    expect(() => connectProject({ projectPath: currentProject, target: "unsafe" })).toThrow(/credential-free/u);

    const outside = join(temporaryRoot(), "outside");
    scaffoldTree({ name: "outside", path: outside });
    symlinkSync(outside, join(managedTreesRoot(), "alias"), "dir");
    expect(() => connectProject({ projectPath: currentProject, target: "alias" })).toThrow(/unsafe destination/u);
  });

  it("removes only the destination created by a failed clone", () => {
    const currentProject = project();
    const marker = join(managedTreesRoot(), "keep");
    mkdirSync(marker);
    const runner: CommandRunner = (command, args) => {
      if (command === "git" && args.includes("clone")) return { status: 1, stderr: "clone failed", stdout: "" };
      return defaultRunner(command, args);
    };
    expect(() => connectProject({ projectPath: currentProject, target: "acme/context" }, runner)).toThrow(
      /clone failed/u,
    );
    expect(existsSync(join(managedTreesRoot(), "context"))).toBe(false);
    expect(existsSync(marker)).toBe(true);
  });
});

// Cleanup uses the ordinary lifecycle. Exercise both publication routes with
// real Git divergence; the GitHub runner substitutes an isolated bare remote.
describe.each(["local", "github"] as const)("%s cleanup concurrency", (kind) => {
  it.each(["ordinary write", "cleanup"])("preserves an intervening %s and the rejected cleanup", (winner) => {
    const currentProject = project();
    const remote = kind === "github" ? bareTree().remote : undefined;
    const runner = remote === undefined ? defaultRunner : githubRunner(remote);
    const treePath =
      remote === undefined
        ? createProject(currentProject).treePath
        : connectProject({ projectPath: currentProject, target: "acme/context" }, runner).tree.path;
    const cleanup = prepareContextWrite(currentProject, runner);
    const peer = prepareContextWrite(currentProject, runner);
    addLeaf(cleanup.worktreePath, "cleanup-attempt");
    addLeaf(peer.worktreePath, "winner");
    const finished = finishContextWrite(
      {
        projectPath: currentProject,
        worktreePath: peer.worktreePath,
        message: winner,
      },
      runner,
    );
    expect(existsSync(peer.worktreePath)).toBe(false);
    expect(() =>
      finishContextWrite(
        {
          projectPath: currentProject,
          worktreePath: cleanup.worktreePath,
          message: "Cleanup rejected snapshot",
        },
        runner,
      ),
    ).toThrow(expect.objectContaining({ code: "WRITE_OUTDATED" }));
    expect(git(remote ?? treePath, ["rev-parse", "refs/heads/trunk"])).toBe(finished.sha);
    expect(git(remote ?? treePath, ["show", "trunk:winner.md"])).toContain("# winner");
    expect(git(cleanup.worktreePath, ["show", "HEAD:cleanup-attempt.md"])).toContain("# cleanup-attempt");
    expect(git(cleanup.worktreePath, ["status", "--porcelain"])).toBe("");

    backdate(cleanup.worktreePath);
    const fresh = prepareContextWrite(currentProject, runner);
    expect(existsSync(cleanup.worktreePath)).toBe(true);
    expect(readTree(fresh.worktreePath, "winner.md").node.body).toContain("# winner");
    expect(existsSync(join(fresh.worktreePath, "cleanup-attempt.md"))).toBe(false);
    // A no-op cleanup leaves this preparation unfinished and creates no commit.
    expect(git(fresh.worktreePath, ["rev-parse", "HEAD"])).toBe(finished.sha);
    backdate(fresh.worktreePath);
    prepareContextWrite(currentProject, runner);
    expect(existsSync(fresh.worktreePath)).toBe(false);
    expect(existsSync(cleanup.worktreePath)).toBe(true);
    expect(git(remote ?? treePath, ["rev-parse", "refs/heads/trunk"])).toBe(finished.sha);
  });
});

it("disconnects idempotently without validating or deleting the tree", () => {
  const currentProject = project();
  const created = createProject(currentProject);
  writeFileSync(join(created.treePath, "NODE.md"), "invalid");
  expect(disconnectProject(currentProject)).toEqual({ schemaVersion: 1, disconnected: true });
  expect(disconnectProject(currentProject)).toEqual({ schemaVersion: 1, disconnected: false });
  expect(existsSync(created.treePath)).toBe(true);
  expect(() => resolveConnection(currentProject)).toThrow(expect.objectContaining({ code: "NO_CONNECTION" }));
});

it("keeps equal repository names under different owners separate", () => {
  const { remote } = bareTree();
  const runner: CommandRunner = (command, args) => {
    if (command === "git" && args.includes("clone")) {
      const url = args[args.length - 2];
      const destination = args[args.length - 1];
      const result = defaultRunner(
        command,
        args.map((arg) => (arg === url ? remote : arg)),
      );
      if (result.status === 0 && destination && url)
        defaultRunner("git", ["-C", destination, "remote", "set-url", "origin", url]);
      return result;
    }
    return defaultRunner(command, args);
  };
  const first = connectProject({ projectPath: project("one"), target: "one/memory" }, runner);
  const second = connectProject({ projectPath: project("two"), target: "two/memory" }, runner);
  expect(first.tree.path).not.toBe(second.tree.path);
  expect(connectProject({ projectPath: project("three"), target: "one/memory" }, runner).tree.path).toBe(
    first.tree.path,
  );
});

describe("multiple equal connections", () => {
  it("creates named trees, rejects collisions and duplicates, and disconnects selectively", () => {
    const current = project();
    const company = createProject(current, undefined, { name: "company", alias: "company" });
    const product = createProject(current, undefined, { name: "product", alias: "product" });
    expect(createProject(current, undefined, { name: "product", alias: "product" }).created).toBe(false);
    expect(connectProject({ projectPath: current, target: "product", alias: "product" }).tree.path).toBe(
      product.treePath,
    );
    expect(resolveConnection(current).connections.map((c) => c.alias)).toEqual(["company", "product"]);
    expect(() => connectProject({ projectPath: current, target: "product", alias: "company" })).toThrow(/alias/);
    expect(() => connectProject({ projectPath: current, target: "product", alias: "duplicate" })).toThrow(
      /another alias/,
    );
    expect(() => prepareContextWrite(current)).toThrow(/--tree/);
    expect(() => publishProject(current)).toThrow(/--tree/);
    expect(() => disconnectProject(current)).toThrow(/--tree/);
    disconnectProject(current, undefined, { tree: "company" });
    expect(existsSync(company.treePath)).toBe(true);
    const prepared = prepareContextWrite(current);
    roots.add(prepared.worktreePath);
    expect(prepared.connection.alias).toBe("product");
    disconnectProject(current, undefined, { all: true });
    expect(() => resolveConnection(current)).toThrow(/No Context Tree/);
  });

  it("discovers and synchronizes healthy trees alongside an unavailable one", () => {
    const current = project();
    const company = createProject(current, undefined, { name: "company" });
    const product = createProject(current, undefined, { name: "product" });
    renameSync(company.treePath, `${company.treePath}-moved`);
    expect(resolveConnection(current).connections.map((c) => [c.alias, c.ok])).toEqual([
      ["company", false],
      ["product", true],
    ]);
    const sync = syncProject(current);
    expect(sync.connections).toMatchObject([
      { alias: "company", ok: false, error: { code: "STALE_CONNECTION" } },
      { alias: "product", ok: true, branch: "trunk", sha: product.commitSha },
    ]);
    expect(syncProject(current, undefined, "product").connections).toHaveLength(1);
  });

  it("writes only the selected tree and retains other connections", () => {
    const current = project();
    const company = createProject(current, undefined, { name: "company" });
    const product = createProject(current, undefined, { name: "product" });
    const prepared = prepareContextWrite(current, undefined, "product");
    addLeaf(prepared.worktreePath, "decision");
    finishContextWrite({ projectPath: current, worktreePath: prepared.worktreePath, message: "Record decision" });
    expect(existsSync(join(product.treePath, "decision.md"))).toBe(true);
    expect(git(company.treePath, ["rev-parse", "HEAD"])).toBe(company.commitSha);
    expect(resolveConnection(current).connections).toHaveLength(2);
  });

  it.each([false, true])("preserves an uncommitted preparation after removal or replacement (%s)", (replace) => {
    const current = project();
    createProject(current, undefined, { name: "original", alias: "chosen" });
    const prepared = prepareContextWrite(current);
    roots.add(prepared.worktreePath);
    addLeaf(prepared.worktreePath, "decision");
    const head = git(prepared.worktreePath, ["rev-parse", "HEAD"]);
    disconnectProject(current);
    if (replace) createProject(current, undefined, { name: "replacement", alias: "chosen" });
    expect(() =>
      finishContextWrite({ projectPath: current, worktreePath: prepared.worktreePath, message: "Must not commit" }),
    ).toThrow();
    expect(git(prepared.worktreePath, ["rev-parse", "HEAD"])).toBe(head);
    expect(existsSync(join(prepared.worktreePath, "decision.md"))).toBe(true);
  });

  it("publishes a shared checkout across projects while preserving aliases and unrelated trees", () => {
    const first = project("first");
    const second = project("second");
    const shared = createProject(first, undefined, { name: "shared", alias: "company" });
    createProject(first, undefined, { name: "unrelated", alias: "product" });
    connectProject({ projectPath: second, treePath: shared.treePath, alias: "organization" });
    const runner: CommandRunner = (command, args) =>
      command === "gh" ? { status: 0, stdout: "", stderr: "" } : defaultRunner(command, args);
    publishProject(first, { tree: "company", repository: "acme/shared" }, runner);
    expect(resolveConnection(first).connections).toMatchObject([
      { alias: "company", tree: { kind: "github", repository: "acme/shared" } },
      { alias: "product", tree: { kind: "local" } },
    ]);
    expect(resolveConnection(second).connections).toMatchObject([
      { alias: "organization", tree: { kind: "github", repository: "acme/shared" } },
    ]);
  });

  it("rejects unsupported stored formats without deleting or rewriting them", () => {
    const current = project();
    createProject(current);
    const path = join(process.env.HOME ?? "", ".context-tree", "connections.json");
    const original = '{"schemaVersion":1,"connections":[]}\n';
    writeFileSync(path, original);
    expect(() => connectProject({ projectPath: current, target: "service-context-tree" })).toThrow(
      /unsupported or corrupt/,
    );
    expect(readFileSync(path, "utf8")).toBe(original);
  });
});
