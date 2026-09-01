import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { connectProject, listManagedTrees, managedTreesRoot, resolveConnection } from "../src/core/connections.js";
import { createProject } from "../src/core/create.js";
import { type CommandRunner, defaultRunner } from "../src/core/internal/git.js";
import { readTree } from "../src/core/read.js";
import { scaffoldTree } from "../src/core/scaffold.js";
import { syncProject } from "../src/core/sync.js";
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

function githubRunner(remote: string, log: string[][] = []): CommandRunner {
  return (command, args) => {
    log.push([command, ...args]);
    if (command === "git" && args.slice(-3).join(" ") === "remote get-url origin") {
      return { status: 0, stderr: "", stdout: "https://github.com/acme/context.git\n" };
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
    expect(resolveConnection(currentProject).tree).toEqual({ kind: "local", path: initialized.treePath });
    expect(syncProject(currentProject)).toMatchObject({ branch: "trunk", tree: { kind: "local" } });

    const prepared = prepareContextWrite(currentProject);
    expect(prepared).toEqual({ schemaVersion: 1, worktreePath: expect.any(String) });
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

  it("is idempotent and automatically switches managed local connections", () => {
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
      `${JSON.stringify({ connections: [record, record], schemaVersion: 1 })}\n`,
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
    expect(resolveConnection(currentProject).tree).toEqual(connected.tree);
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

describe("GitHub lifecycle", () => {
  it("clones, syncs the checked-out branch, and pushes one direct write", () => {
    const { remote } = bareTree();
    const currentProject = project();
    const log: string[][] = [];
    const runner = githubRunner(remote, log);
    const connected = connectProject({ projectPath: currentProject, target: "acme/context" }, runner);
    expect(connected.tree).toMatchObject({ kind: "github", repository: "acme/context" });
    expect(connectProject({ projectPath: currentProject, target: "acme/context" }, runner)).toEqual(connected);
    expect(syncProject(currentProject, runner).branch).toBe("trunk");
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
    ).toThrow(/does not belong/u);
  });

  it("fails repository-name collisions before switching the project connection", () => {
    const currentProject = project();
    const local = createProject(currentProject);
    const occupied = join(managedTreesRoot(), "context");
    scaffoldTree({ name: "context", path: occupied });
    expect(() => connectProject({ projectPath: currentProject, target: "acme/context" })).toThrow(/different tree/u);
    expect(resolveConnection(currentProject).tree.path).toBe(local.treePath);
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
