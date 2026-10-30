import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type CommandRunner, git } from "../src/adapters/git.js";
import { atomicState, stateDirectory } from "../src/adapters/state.js";
import { SCHEMA_VERSION, type WriteSession } from "../src/contracts/index.js";
import { connect, connection } from "../src/operations/connections.js";
import { connectTree, syncTrees } from "../src/operations/trees.js";
import { abortWrite, finishWrite, loadWriteSession, prepareWrite } from "../src/operations/write.js";
import { identityId, sourceSelector } from "../src/sources/identity.js";
import { managedRepository, resolveSource } from "../src/sources/resolve.js";
import { scaffoldTree } from "../src/tree/scaffold.js";
import { commit, node, remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();
const source = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;

function setup(): ReturnType<typeof remoteFixture> {
  const remote = remoteFixture(fixture().home);
  mkdirSync(join(remote.seed, "src"));
  writeFileSync(join(remote.seed, "src/code.ts"), "export const value = 1;\n");
  writeFileSync(join(remote.seed, ".gitignore"), "secret.txt\n");
  commit(remote.seed);
  git(remote.seed, ["push", remote.remote, "main"]);
  return remote;
}

describe("managed sparse worktrees", () => {
  it("separates snapshots by subtree and reuses the same path and commit across refs", () => {
    const { project } = fixture();
    const { runner, seed, remote, calls } = setup();
    git(seed, ["push", remote, "main:feature"]);
    const docs = connectTree(project, source, runner);
    const handbook = connectTree(project, { ...source, path: "handbook" }, runner);
    const feature = connectTree(project, { ...source, ref: "feature" }, runner);
    expect(docs.repository?.root).not.toBe(handbook.repository?.root);
    expect(feature.treeRoot).toBe(docs.treeRoot);
    expect(existsSync(join(docs.treeRoot, "NODE.md"))).toBe(true);
    expect(existsSync(join(docs.treeRoot, "../handbook"))).toBe(false);
    expect(existsSync(join(handbook.treeRoot, "../docs"))).toBe(false);
    expect(existsSync(join(docs.treeRoot, "../src"))).toBe(false);
    expect(existsSync(join(docs.treeRoot, "../code.ts"))).toBe(true);
    expect(calls.filter((args) => args.includes("clone"))).toHaveLength(1);
    const selected = connection(project, sourceSelector(project, source));
    expect(resolveSource(selected, false, runner).treeRoot).toBe(docs.treeRoot);
  });

  it.each(["docs/nested", '"quoted', "space notes", "[notes]*"])("checks out literal subtree %s", (path) => {
    const { project } = fixture();
    const { runner, seed, remote } = setup();
    scaffoldTree(join(seed, path), "Selected");
    commit(seed);
    git(seed, ["push", remote, "main"]);
    const tree = connectTree(project, { ...source, path }, runner);
    expect(readFileSync(join(tree.treeRoot, "NODE.md"), "utf8")).toContain("Selected");
    expect(existsSync(join(tree.repository?.root ?? "", "src"))).toBe(false);
    const session = prepareWrite(project, undefined, runner);
    expect(readFileSync(join(session.treeRoot, "NODE.md"), "utf8")).toContain("Selected");
    abortWrite(session.id, runner);
  });

  it("creates a new snapshot offline from an existing bare cache without touching a legacy snapshot", () => {
    const { home, project } = fixture();
    const { runner, calls } = setup();
    connect(project, source);
    const repository = managedRepository(source, true, runner);
    const legacy = join(stateDirectory("snapshots"), `${identityId(source.repository)}-${repository.sha}`);
    git(repository.root, ["worktree", "add", "--quiet", "--detach", legacy, repository.sha]);
    writeFileSync(join(legacy, "docs/pending.md"), node("Preserve legacy"));
    const before = calls.length;
    const result = syncTrees(project, undefined, true, runner).connections[0];
    expect(result?.ok).toBe(true);
    if (!result?.ok) throw new Error("Expected offline snapshot");
    expect(result.repository?.root).not.toBe(legacy);
    expect(existsSync(join(result.treeRoot, "../src"))).toBe(false);
    expect(calls.slice(before).some((args) => args.includes("fetch") || args.includes("clone"))).toBe(false);
    expect(readFileSync(join(legacy, "docs/pending.md"), "utf8")).toContain("Preserve legacy");
    expect(existsSync(join(legacy, "src/code.ts"))).toBe(true);
    expect(readdirSync(join(home, ".context-tree/repositories")).filter((name) => name.endsWith(".git"))).toHaveLength(
      1,
    );
  });

  it("preserves every outside blob when committing and publishing sparse edits", () => {
    const { project } = fixture();
    const { runner, remote } = setup();
    connectTree(project, source, runner);
    const base = git(remote, ["rev-parse", "main"]);
    const session = prepareWrite(project, undefined, runner);
    expect(existsSync(join(session.worktreeRoot, "src"))).toBe(false);
    expect(git(session.worktreeRoot, ["write-tree"])).toBe(git(remote, ["rev-parse", "main^{tree}"]));
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    const retained = finishWrite(session.id, "Record choice", false, runner);
    expect(retained).toMatchObject({ outcome: "committed", sessionId: session.id });
    expect(git(remote, ["rev-parse", "main"])).toBe(base);
    expect(finishWrite(session.id, "Publish", true, runner).outcome).toBe("published");
    const outside = (ref: string): string[] =>
      git(remote, ["ls-tree", "-r", ref])
        .split("\n")
        .filter((line) => !line.split("\t")[1]?.startsWith("docs/"));
    expect(outside("main")).toEqual(outside(base));
    expect(git(remote, ["diff", "--name-only", base, "main"])).toBe("docs/choice.md");
    expect(existsSync(session.worktreeRoot)).toBe(false);
  });

  it.each(["unstaged", "staged", "untracked", "ignored"])("preserves %s edits outside the sparse cone", (kind) => {
    const { project } = fixture();
    const { runner } = setup();
    connectTree(project, source, runner);
    const session = prepareWrite(project, undefined, runner);
    mkdirSync(join(session.worktreeRoot, "src"), { recursive: true });
    const path = kind === "ignored" ? "secret.txt" : kind === "untracked" ? "src/new.ts" : "src/code.ts";
    writeFileSync(join(session.worktreeRoot, path), "outside edits");
    if (kind === "staged") git(session.worktreeRoot, ["add", "--sparse", "--", path]);
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    expect(() => finishWrite(session.id, "Reject", false, runner)).toThrow(
      expect.objectContaining({ code: "OUTSIDE_TREE" }),
    );
    expect(() => abortWrite(session.id, runner)).toThrow(/contains work/);
    expect(readFileSync(join(session.worktreeRoot, path), "utf8")).toBe("outside edits");
    expect(loadWriteSession(session.id).commit).toBeNull();
  });

  it("keeps root Git sources and directory sources fully checked out after sparse cache configuration", () => {
    const { project } = fixture();
    const { runner, seed, remote } = setup();
    connectTree(project, source, runner);
    writeFileSync(join(seed, "NODE.md"), readFileSync(join(seed, "docs/NODE.md")));
    writeFileSync(join(seed, "docs/NODE.md"), node("Docs"));
    writeFileSync(join(seed, "handbook/NODE.md"), node("Handbook"));
    writeFileSync(join(seed, "src/NODE.md"), node("Source"));
    commit(seed);
    git(seed, ["push", remote, "main"]);
    const rootSource = { ...source, path: "." };
    const root = connectTree(project, rootSource, runner);
    expect(existsSync(join(root.treeRoot, "src/code.ts"))).toBe(true);
    const managed = prepareWrite(project, sourceSelector(project, rootSource), runner);
    expect(existsSync(join(managed.worktreeRoot, "src/code.ts"))).toBe(true);
    abortWrite(managed.id, runner);
    connectTree(project, { kind: "directory", path: seed });
    const config = readFileSync(join(seed, ".git/config"));
    const local = prepareWrite(project, seed);
    expect(existsSync(join(local.worktreeRoot, "src/code.ts"))).toBe(true);
    abortWrite(local.id);
    expect(readFileSync(join(seed, ".git/config"))).toEqual(config);
  });

  it("finishes and aborts preexisting full sessions after sparse worktree configuration", () => {
    const { project } = fixture();
    const { runner, remote } = setup();
    const selected = connect(project, source);
    const repository = managedRepository(source, true, runner);
    const legacySession = (): WriteSession => {
      const id = randomUUID();
      const worktreeRoot = join(stateDirectory("worktrees"), id);
      const taskBranch = `context-tree/write/${id}`;
      git(repository.root, ["worktree", "add", "--quiet", "-b", taskBranch, worktreeRoot, repository.sha]);
      const session: WriteSession = {
        schemaVersion: SCHEMA_VERSION,
        id,
        connection: selected,
        treeRoot: join(worktreeRoot, "docs"),
        repository: { ...repository, directory: "docs", branch: "main" },
        worktreeRoot,
        taskBranch,
        commit: null,
      };
      atomicState(join(stateDirectory("sessions"), `${id}.json`), session);
      return session;
    };
    const old = legacySession();
    const empty = legacySession();
    const retained = legacySession();
    writeFileSync(join(retained.treeRoot, "retained.md"), node("Retained"));
    const savedCommit = finishWrite(retained.id, "Previously committed", false, runner).sha;
    writeFileSync(join(old.treeRoot, "pending.md"), node("Pending"));
    const original = readFileSync(join(stateDirectory("sessions"), `${old.id}.json`));
    const fresh = prepareWrite(project, undefined, runner);
    expect(readFileSync(join(stateDirectory("sessions"), `${old.id}.json`))).toEqual(original);
    expect(git(repository.root, ["rev-parse", "--is-bare-repository"])).toBe("true");
    expect(existsSync(join(old.worktreeRoot, "src/code.ts"))).toBe(true);
    expect(existsSync(join(fresh.worktreeRoot, "src"))).toBe(false);
    expect(finishWrite(retained.id, "Review saved commit", false, runner).sha).toBe(savedCommit);
    expect(finishWrite(old.id, "Preserve old work", false, runner).outcome).toBe("committed");
    expect(finishWrite(old.id, "Publish old work", true, runner).outcome).toBe("published");
    expect(git(remote, ["show", "main:docs/pending.md"])).toContain("Pending");
    abortWrite(empty.id, runner);
    expect(finishWrite(fresh.id, "Empty", false, runner).outcome).toBe("unchanged");
    expect(existsSync(empty.worktreeRoot)).toBe(false);
  });

  it("rejects modified sparse snapshots without pruning the edits", () => {
    const { project } = fixture();
    const { runner } = setup();
    const tree = connectTree(project, source, runner);
    const root = tree.repository?.root;
    if (!root) throw new Error("Expected snapshot");
    mkdirSync(join(root, "src"));
    writeFileSync(join(root, "src/code.ts"), "Changed outside cone");
    expect(syncTrees(project, undefined, true, runner).connections[0]).toMatchObject({
      ok: false,
      error: { code: "DIRTY_TREE" },
    });
    expect(readFileSync(join(root, "src/code.ts"), "utf8")).toBe("Changed outside cone");
  });

  it("does not register a session when sparse setup fails and preserves the partial worktree", () => {
    const { project, home } = fixture();
    const remote = setup();
    connectTree(project, source, remote.runner);
    const runner: CommandRunner = (command, args) =>
      args.includes("read-tree") ? { status: 1, stdout: "", stderr: "Checkout failed" } : remote.runner(command, args);
    expect(() => prepareWrite(project, undefined, runner)).toThrow(/Checkout failed/);
    expect(readdirSync(stateDirectory("sessions"))).toEqual([]);
    expect(readdirSync(join(home, ".context-tree/worktrees"))).toHaveLength(1);
  });

  it("rejects an interrupted snapshot instead of adopting or overwriting it", () => {
    const { project } = fixture();
    const remote = setup();
    connect(project, source);
    const runner: CommandRunner = (command, args) =>
      args.includes("read-tree")
        ? { status: 1, stdout: "", stderr: "Checkout interrupted" }
        : remote.runner(command, args);
    expect(syncTrees(project, undefined, true, runner).connections[0]?.ok).toBe(false);
    managedRepository(source, true, remote.runner);
    expect(syncTrees(project, undefined, true, runner).connections[0]).toMatchObject({
      ok: false,
      error: { message: expect.stringContaining("Checkout interrupted") },
    });
    const roots = readdirSync(stateDirectory("snapshots"));
    expect(roots).toHaveLength(1);
    const partial = join(stateDirectory("snapshots"), roots[0] ?? "");
    writeFileSync(join(partial, "pending.txt"), "Preserve interrupted work");
    expect(syncTrees(project, undefined, true, remote.runner).connections[0]).toMatchObject({
      ok: false,
      error: { code: "DIRTY_TREE" },
    });
    expect(readFileSync(join(partial, "pending.txt"), "utf8")).toBe("Preserve interrupted work");
  });

  it("rejects unsupported Git before creating a sparse worktree", () => {
    const { project } = fixture();
    const remote = setup();
    const runner: CommandRunner = (command, args) =>
      args.includes("version")
        ? { status: 0, stdout: "git version 2.35.0\n", stderr: "" }
        : remote.runner(command, args);
    expect(() => connectTree(project, source, runner)).toThrow(/Git 2\.36/);
    expect(remote.calls.some((args) => args.includes("worktree") && args.includes("add"))).toBe(false);
  });
});
