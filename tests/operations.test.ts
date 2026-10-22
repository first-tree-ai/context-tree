import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { type CommandRunner, git, gitRaw } from "../src/adapters/git.js";
import { readState, withLock } from "../src/adapters/state.js";
import { SCHEMA_VERSION } from "../src/contracts/index.js";
import { connection, connections, disconnect } from "../src/operations/connections.js";
import { connectTree, initTree, syncTrees } from "../src/operations/trees.js";
import { abortWrite, finishWrite, loadWriteSession, prepareWrite } from "../src/operations/write.js";
import { connectionIdentity, sourceName, sourceSelector } from "../src/sources/identity.js";
import { projectRoot } from "../src/sources/project.js";
import { resolveSource } from "../src/sources/resolve.js";
import { readTree } from "../src/tree/read.js";
import { scaffoldTree } from "../src/tree/scaffold.js";
import { verifyTree } from "../src/tree/verify.js";
import { commit, initRepository, node, remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();
const gitSource = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;

describe("directory sources", () => {
  it("initializes embedded content without changing Git state or project instructions", () => {
    const { project } = fixture();
    initRepository(project);
    writeFileSync(join(project, "AGENTS.md"), "Keep me");
    const head = git(project, ["rev-parse", "HEAD"]);
    const result = initTree(project, join(project, "docs"));
    expect(result.connection.source).toEqual({ kind: "directory", path: "docs" });
    expect(readState(join(project, ".context-tree.json"))).toEqual({
      schemaVersion: SCHEMA_VERSION,
      trees: [{ kind: "directory", path: "docs" }],
    });
    expect(git(project, ["rev-parse", "HEAD"])).toBe(head);
    expect(git(project, ["diff", "--cached", "--name-only"])).toBe("");
    expect(readFileSync(join(project, "AGENTS.md"), "utf8")).toBe("Keep me");
    expect(existsSync(join(project, "docs/.git"))).toBe(false);
    expect(existsSync(join(project, "docs/AGENTS.md"))).toBe(false);
    expect(existsSync(join(project, "docs/.github"))).toBe(false);
  });
  it("supports standalone directories without Git", () => {
    const { project } = fixture();
    const result = initTree(project, project);
    expect(result.repository).toBeNull();
    writeFileSync(join(result.treeRoot, "choice.md"), node("Choice"));
    expect(verifyTree(result.treeRoot).ok).toBe(true);
    expect(() => prepareWrite(project)).toThrow(/committed Git repository/u);
    expect(existsSync(join(project, ".git"))).toBe(false);
  });
  it("reads and edits dirty docs without staging or publishing unrelated host work", () => {
    const { project } = fixture();
    initRepository(project);
    initTree(project, join(project, "docs"));
    commit(project);
    writeFileSync(join(project, "code.ts"), "staged code\n");
    git(project, ["add", "code.ts"]);
    writeFileSync(join(project, "docs/choice.md"), node("Uncommitted choice"));
    const index = gitRaw(project, ["diff", "--cached"]);
    expect(syncTrees(project).connections[0]).toMatchObject({ ok: true, dirty: true });
    const tree = resolveSource(connection(project));
    writeFileSync(join(tree.treeRoot, "choice.md"), node("Revised choice"));
    expect(verifyTree(tree.treeRoot).ok).toBe(true);
    expect(gitRaw(project, ["diff", "--cached"])).toBe(index);
    expect(readTree(join(project, "docs"), "choice.md").node.body).toContain("Revised");
  });
  it("resolves relative declarations inside each worktree", () => {
    const { home, project } = fixture();
    initRepository(project);
    initTree(project, join(project, "docs"));
    commit(project);
    const worktree = join(home, "branch");
    git(project, ["worktree", "add", "--quiet", "-b", "feature", worktree]);
    expect(resolveSource(connection(worktree)).treeRoot).toBe(join(worktree, "docs"));
    expect(projectRoot(join(worktree, "docs"))).toBe(worktree);
    expect(connection(project).projectRoot).not.toBe(connection(worktree).projectRoot);
  });
  it("attaches external local directories explicitly without owning their Git workflow", () => {
    const { home, project } = fixture();
    const tree = scaffoldTree(join(home, "external"), "External");
    connectTree(project, { kind: "directory", path: tree });
    expect(resolveSource(connection(project)).treeRoot).toBe(tree);
  });
  it("preserves existing content when initialization fails", () => {
    const { project } = fixture();
    mkdirSync(join(project, "docs"));
    writeFileSync(join(project, "docs/README.md"), "# Existing docs");
    expect(() => initTree(project, join(project, "docs"))).toThrow(/format/u);
    expect(readFileSync(join(project, "docs/README.md"), "utf8")).toBe("# Existing docs");
    expect(existsSync(join(project, "docs/NODE.md"))).toBe(false);
    expect(existsSync(join(project, ".context-tree.json"))).toBe(false);
  });
  it("rejects symlink roots, intermediate symlinks, and escaping declarations", () => {
    const { project, home } = fixture();
    const tree = scaffoldTree(join(home, "external"), "External");
    symlinkSync(tree, join(project, "docs"));
    expect(() => connectTree(project, { kind: "directory", path: "docs" })).toThrow(/symlink/u);
    mkdirSync(join(tree, "nested"));
    symlinkSync(tree, join(project, "link"));
    expect(() => initTree(project, join(project, "link/nested/tree"))).toThrow(/symlink/u);
    writeFileSync(
      join(project, ".context-tree.json"),
      JSON.stringify({ schemaVersion: 3, trees: [{ kind: "directory", path: "../external" }] }),
    );
    expect(() => connections(project)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
  it("rejects old configuration and does not read the removed global registry", () => {
    const { home, project } = fixture();
    mkdirSync(join(home, ".context-tree"));
    writeFileSync(join(home, ".context-tree/connections.json"), '{"schemaVersion":2,"connections":[]}');
    expect(() => connections(project)).toThrow(expect.objectContaining({ code: "NO_CONNECTION" }));
    writeFileSync(join(project, ".context-tree.json"), '{"schemaVersion":2,"connections":[]}');
    expect(() => connections(project)).toThrow(expect.objectContaining({ code: "INVALID_CONFIG" }));
  });
  it("serializes configuration updates and makes repeated connections idempotent", () => {
    const { project } = fixture();
    initTree(project, join(project, "docs"));
    const second = scaffoldTree(join(project, "handbook"), "Handbook");
    withLock(join(project, ".context-tree.json.lock"), () => {
      expect(() => connectTree(project, { kind: "directory", path: second })).toThrow(
        expect.objectContaining({ code: "BUSY" }),
      );
    });
    connectTree(project, { kind: "directory", path: "handbook" });
    expect(() => connection(project)).toThrow(expect.objectContaining({ code: "AMBIGUOUS_CONNECTION" }));
    connectTree(project, { kind: "directory", path: "docs" });
    expect(connections(project)).toHaveLength(2);
    disconnect(project, "docs");
    expect(connection(project).source).toEqual({ kind: "directory", path: "handbook" });
    expect(existsSync(join(project, "docs/NODE.md"))).toBe(true);
  });
});

describe("isolated writes", () => {
  function setup(): string {
    const { project } = fixture();
    initRepository(project);
    initTree(project, join(project, "docs"));
    commit(project);
    return project;
  }
  it("creates a review branch without changing the host checkout or index", () => {
    const project = setup();
    writeFileSync(join(project, "code.ts"), "staged code");
    git(project, ["add", "code.ts"]);
    const head = git(project, ["rev-parse", "HEAD"]);
    const staged = gitRaw(project, ["diff", "--cached"]);
    const session = prepareWrite(project);
    expect(session.treeRoot).toBe(join(session.worktreeRoot, "docs"));
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    const result = finishWrite(session.id, "Record choice");
    expect(result).toMatchObject({ outcome: "committed", sessionId: session.id });
    expect(git(project, ["rev-parse", "HEAD"])).toBe(head);
    expect(gitRaw(project, ["diff", "--cached"])).toBe(staged);
    expect(existsSync(join(project, "docs/choice.md"))).toBe(false);
    expect(finishWrite(session.id, "Retry").sha).toBe(result.sha);
    expect(() => finishWrite(session.id, "No push", true)).toThrow(/host's Git workflow/u);
    expect(() => abortWrite(session.id)).toThrow(/contains work/u);
  });
  it.each(["unstaged", "staged", "untracked", "ignored", "rename"])("rejects %s changes outside the tree", (kind) => {
    const project = setup();
    if (kind === "ignored") {
      writeFileSync(join(project, ".gitignore"), "secret.txt\n");
      commit(project);
    }
    const session = prepareWrite(project);
    const root = session.worktreeRoot;
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    if (kind === "rename") renameSync(join(root, "code.ts"), join(session.treeRoot, "code.md"));
    else
      writeFileSync(
        join(root, kind === "ignored" ? "secret.txt" : kind === "untracked" ? "new.txt" : "code.ts"),
        "outside",
      );
    if (kind === "staged") git(root, ["add", "code.ts"]);
    expect(() => finishWrite(session.id, "Reject outside edits")).toThrow(
      expect.objectContaining({ code: "OUTSIDE_TREE" }),
    );
    expect(git(root, ["rev-parse", "HEAD"])).toBe(session.repository.sha);
    expect(existsSync(session.treeRoot)).toBe(true);
  });
  it("rejects branch changes and replaced connections", () => {
    const project = setup();
    const session = prepareWrite(project);
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    git(project, ["switch", "--quiet", "-c", "other"]);
    expect(() => finishWrite(session.id, "Wrong branch")).toThrow(/branch changed/u);
    git(project, ["switch", "--quiet", "main"]);
    disconnect(project, "docs");
    expect(() => finishWrite(session.id, "Removed")).toThrow(expect.objectContaining({ code: "NO_CONNECTION" }));
    expect(existsSync(session.treeRoot)).toBe(true);
  });
  it("rejects agent-created commits and invalid tree content", () => {
    const project = setup();
    const session = prepareWrite(project);
    writeFileSync(join(session.treeRoot, "bad.md"), "# No metadata");
    expect(() => finishWrite(session.id, "Invalid")).toThrow(expect.objectContaining({ code: "INVALID_TREE" }));
    writeFileSync(join(session.treeRoot, "bad.md"), node("Valid"));
    commit(session.worktreeRoot);
    expect(() => finishWrite(session.id, "Already committed")).toThrow(/Git state changed/u);
  });
  it("requires a clean subtree for isolated writes", () => {
    const project = setup();
    writeFileSync(join(project, "docs/choice.md"), node("Pending"));
    expect(() => prepareWrite(project)).toThrow(expect.objectContaining({ code: "DIRTY_TREE" }));
  });
  it("releases empty sessions and never discards pending edits", () => {
    const project = setup();
    const empty = prepareWrite(project);
    expect(finishWrite(empty.id, "Empty").outcome).toBe("unchanged");
    expect(existsSync(empty.treeRoot)).toBe(false);
    const dirty = prepareWrite(project);
    writeFileSync(join(dirty.treeRoot, "choice.md"), node("Choice"));
    expect(() => abortWrite(dirty.id)).toThrow(/contains work/u);
    expect(lstatSync(dirty.treeRoot).isDirectory()).toBe(true);
    const emptyAbort = prepareWrite(project);
    abortWrite(emptyAbort.id);
    expect(existsSync(emptyAbort.treeRoot)).toBe(false);
    expect(existsSync(join(project, "docs/NODE.md"))).toBe(true);
  });
});

describe("managed Git subtrees", () => {
  it("keeps repository identity across transport URL rewrites during sync and publication", () => {
    const { home, project } = fixture();
    const remote = remoteFixture(home);
    const runner: CommandRunner = (command, args) =>
      remote.runner(command, ["-c", "url.http://github.com/.insteadOf=https://github.com/", ...args]);
    const connected = connectTree(project, gitSource, runner);
    const root = connected.repository?.root;
    if (!root) throw new Error("Expected a repository cache");
    expect(git(root, ["remote", "get-url", "origin"], { runner })).toBe("http://github.com/acme/context.git");
    expect(git(root, ["config", "--local", "--get", "remote.origin.url"], { runner })).toBe(
      "https://github.com/acme/context.git",
    );
    expect(syncTrees(project, undefined, false, runner).connections[0]?.ok).toBe(true);
    const session = prepareWrite(project, undefined, runner);
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    const result = finishWrite(session.id, "Record choice", true, runner);
    expect(result.outcome).toBe("published");
    expect(git(remote.remote, ["show", "main:docs/choice.md"])).toContain("Choice");
  });
  it("rejects a changed stored origin and preserves unpublished work", () => {
    const { home, project } = fixture();
    const { runner } = remoteFixture(home);
    const connected = connectTree(project, gitSource, runner);
    const root = connected.repository?.root;
    if (!root) throw new Error("Expected a repository cache");
    const session = prepareWrite(project, undefined, runner);
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    git(root, ["remote", "set-url", "origin", "https://github.com/acme/other.git"]);
    expect(syncTrees(project, undefined, true, runner).connections[0]).toMatchObject({
      ok: false,
      error: expect.objectContaining({ message: "Repository cache identity changed." }),
    });
    expect(() => finishWrite(session.id, "Record choice", true, runner)).toThrow(/Remote identity changed/u);
    expect(readFileSync(join(session.treeRoot, "choice.md"), "utf8")).toContain("Choice");
    expect(loadWriteSession(session.id).commit).not.toBeNull();
  });
  it("uses cached snapshots offline and fetches the target branch during sync", () => {
    const { home, project } = fixture();
    const { runner, seed, remote, calls } = remoteFixture(home);
    connectTree(project, gitSource, runner);
    const fetchCount = (): number => calls.filter((args) => args.includes("fetch")).length;
    const before = fetchCount();
    writeFileSync(join(seed, "docs/choice.md"), node("New"));
    commit(seed);
    git(seed, ["push", remote, "main"]);
    const cached = syncTrees(project, undefined, true, runner).connections[0];
    expect(cached?.ok).toBe(true);
    if (!cached?.ok) throw new Error("Expected cached tree");
    expect(fetchCount()).toBe(before);
    expect(existsSync(join(cached.treeRoot, "choice.md"))).toBe(false);
    const fresh = syncTrees(project, undefined, false, runner).connections[0];
    expect(fresh?.ok).toBe(true);
    if (!fresh?.ok) throw new Error("Expected refreshed tree");
    expect(fetchCount()).toBe(before + 1);
    expect(readTree(fresh.treeRoot, "choice.md").node.body).toContain("New");
    expect(existsSync(join(cached.treeRoot, "choice.md"))).toBe(false);
  });
  it("shares repository storage while distinguishing subtree and ref identities", () => {
    const { home, project } = fixture();
    const { runner, seed, remote, calls } = remoteFixture(home);
    git(seed, ["branch", "feature"]);
    git(seed, ["push", remote, "feature"]);
    connectTree(project, gitSource, runner);
    connectTree(project, { ...gitSource, path: "handbook" }, runner);
    connectTree(project, { ...gitSource, ref: "feature" }, runner);
    expect(new Set(connections(project).map(connectionIdentity)).size).toBe(3);
    expect(calls.filter((args) => args.includes("clone"))).toHaveLength(1);
    const docs = resolveSource(connection(project, sourceSelector(project, gitSource)), false, runner);
    const handbook = resolveSource(
      connection(project, sourceSelector(project, { ...gitSource, path: "handbook" })),
      false,
      runner,
    );
    expect(docs.repository?.root).toBe(handbook.repository?.root);
    expect(docs.treeRoot).not.toBe(handbook.treeRoot);
  });
  it("commits only the selected subtree and publishes only when explicitly requested", () => {
    const { home, project } = fixture();
    const { runner, remote } = remoteFixture(home);
    connectTree(project, gitSource, runner);
    const before = git(remote, ["rev-parse", "main"]);
    const session = prepareWrite(project, undefined, runner);
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    const retained = finishWrite(session.id, "Record choice", false, runner);
    expect(git(remote, ["rev-parse", "main"])).toBe(before);
    expect(retained.outcome).toBe("committed");
    const result = finishWrite(session.id, "Publish saved commit", true, runner);
    expect(result.outcome).toBe("published");
    expect(git(remote, ["rev-parse", "main"])).toBe(retained.sha);
    expect(git(remote, ["diff", "--name-only", before, "main"])).toBe("docs/choice.md");
    expect(existsSync(session.treeRoot)).toBe(false);
  });
  it("preserves a committed session on concurrent publication and allows a fresh semantic retry", () => {
    const { home, project } = fixture();
    const { runner, remote } = remoteFixture(home);
    connectTree(project, gitSource, runner);
    const first = prepareWrite(project, undefined, runner);
    const second = prepareWrite(project, undefined, runner);
    writeFileSync(join(first.treeRoot, "first.md"), node("First"));
    writeFileSync(join(second.treeRoot, "second.md"), node("Second"));
    const winner = finishWrite(first.id, "First", true, runner);
    expect(() => finishWrite(second.id, "Second", true, runner)).toThrow(
      expect.objectContaining({ code: "WRITE_OUTDATED" }),
    );
    expect(loadWriteSession(second.id).commit).not.toBeNull();
    expect(existsSync(second.treeRoot)).toBe(true);
    expect(git(remote, ["rev-parse", "main"])).toBe(winner.sha);
    const retry = prepareWrite(project, undefined, runner);
    expect(readTree(retry.treeRoot, "first.md").node.body).toContain("First");
  });
  it("returns independent failures without hiding healthy sources", () => {
    const { home, project } = fixture();
    const { runner } = remoteFixture(home);
    connectTree(project, gitSource, runner);
    initTree(project, join(project, "local"));
    writeFileSync(join(project, "local/NODE.md"), "broken");
    const entries = syncTrees(project, undefined, true, runner).connections;
    expect(
      entries.map((entry) => [sourceName(entry.connection.projectRoot, entry.connection.source), entry.ok]),
    ).toEqual([
      ["context", true],
      ["local", false],
    ]);
  });
});

describe("write isolation regressions", () => {
  it("ignores inherited Git checkout and index overrides", () => {
    const { project, home } = fixture();
    initRepository(project);
    initTree(project, join(project, "docs"));
    commit(project);
    const other = join(home, "other");
    initRepository(other);
    const index = readFileSync(join(other, ".git/index"));
    vi.stubEnv("GIT_DIR", join(other, ".git"));
    vi.stubEnv("GIT_WORK_TREE", other);
    vi.stubEnv("GIT_INDEX_FILE", join(other, ".git/index"));
    const session = prepareWrite(project);
    writeFileSync(join(session.treeRoot, "decision.md"), node("Decision"));
    expect(finishWrite(session.id, "Record decision").outcome).toBe("committed");
    expect(readFileSync(join(other, ".git/index"))).toEqual(index);
    expect(existsSync(join(project, "docs/decision.md"))).toBe(false);
  });
  it("rejects a mutated remote snapshot, including ignored files", () => {
    const { project, home } = fixture();
    const { runner, seed, remote } = remoteFixture(home);
    writeFileSync(join(seed, ".gitignore"), "secret.txt\n");
    commit(seed);
    git(seed, ["push", remote, "main"]);
    const connected = connectTree(
      project,
      { kind: "git", repository: "acme/context", path: "docs", ref: "main" },
      runner,
    );
    writeFileSync(join(connected.repository?.root ?? "", "secret.txt"), "not part of snapshot");
    const result = syncTrees(project, "context", true, runner);
    expect(result.connections[0]).toMatchObject({ ok: false, error: { code: "DIRTY_TREE" } });
  });
});

describe("source-derived selection", () => {
  it("reports same-name directories and accepts their full paths without assigning names", () => {
    const { project, home } = fixture();
    initTree(project, join(project, "docs"));
    const external = scaffoldTree(join(home, "external/docs"), "External");
    connectTree(project, { kind: "directory", path: external });
    expect(() => connection(project, "docs")).toThrow(join(project, "docs"));
    expect(() => syncTrees(project, "docs")).toThrow(external);
    expect(connection(project, external).source).toEqual({ kind: "directory", path: external });
    expect(syncTrees(project).connections).toHaveLength(2);
    disconnect(project, external);
    expect(connection(project, "docs").source).toEqual({ kind: "directory", path: "docs" });
  });
  it("derives the name of a project-root tree from the actual directory", () => {
    const { project } = fixture();
    initTree(project, project);
    expect(connection(project, "project").source).toEqual({ kind: "directory", path: "." });
    expect(connection(project, project)).toEqual(connection(project));
  });
  it("keeps prepared writes bound to their source after a namesake is connected and the list reordered", () => {
    const { project, home } = fixture();
    initRepository(project);
    initTree(project, join(project, "docs"));
    commit(project);
    const session = prepareWrite(project, "docs");
    const external = scaffoldTree(join(home, "external/docs"), "Other docs");
    connectTree(project, { kind: "directory", path: external });
    writeFileSync(
      join(project, ".context-tree.json"),
      JSON.stringify({
        schemaVersion: 3,
        trees: [
          { kind: "directory", path: external },
          { kind: "directory", path: "docs" },
        ],
      }),
    );
    writeFileSync(join(session.treeRoot, "choice.md"), node("Choice"));
    expect(finishWrite(session.id, "Record choice").outcome).toBe("committed");
    expect(existsSync(join(external, "choice.md"))).toBe(false);
    const next = prepareWrite(project, join(project, "docs"));
    disconnect(project, join(project, "docs"));
    expect(() => finishWrite(next.id, "Must not select namesake")).toThrow(/No matching/);
  });
  it("distinguishes Git repositories, subtrees, and refs without ambiguous URL encodings", () => {
    const { project } = fixture();
    const sources = [
      gitSource,
      { ...gitSource, repository: "other/context" },
      { ...gitSource, path: "handbook" },
      { ...gitSource, ref: "feature/docs" },
      { ...gitSource, ref: "feature", path: "docs/docs" },
    ];
    writeFileSync(join(project, ".context-tree.json"), JSON.stringify({ schemaVersion: 3, trees: sources }));
    expect(() => connection(project, "context")).toThrow("https://github.com/other/context/tree/main/docs");
    expect(new Set(sources.map((source) => sourceSelector(project, source))).size).toBe(sources.length);
    for (const source of sources) expect(connection(project, sourceSelector(project, source)).source).toEqual(source);
    expect(sourceSelector(project, { ...gitSource, ref: "feature/docs" })).toBe(
      "https://github.com/acme/context/tree/feature%2Fdocs/docs",
    );
  });
  it("rejects alias maps, null configuration, and duplicate sources", () => {
    const { project } = fixture();
    for (const config of [
      null,
      { schemaVersion: 3, trees: { docs: { kind: "directory", path: "docs" } } },
      {
        schemaVersion: 3,
        trees: [
          { kind: "directory", path: "docs" },
          { kind: "directory", path: join(project, "docs") },
        ],
      },
      { schemaVersion: 3, trees: [gitSource, { ...gitSource, repository: "Acme/Context" }] },
    ]) {
      writeFileSync(join(project, ".context-tree.json"), JSON.stringify(config));
      expect(() => connections(project)).toThrow(/Invalid|Duplicate/);
    }
  });
});
