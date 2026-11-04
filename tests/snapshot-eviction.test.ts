import { existsSync, mkdirSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/adapters/git.js";
import { withLock } from "../src/adapters/state.js";
import { connectTree, syncTrees } from "../src/operations/trees.js";
import { abortWrite, prepareWrite } from "../src/operations/write.js";
import { SNAPSHOT_RETENTION_MS, touchSnapshotContaining } from "../src/sources/eviction.js";
import { commit, node, remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();
const source = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;

function advance(seed: string, remote: string, title: string): void {
  writeFileSync(join(seed, `docs/${title.toLowerCase()}.md`), node(title));
  commit(seed);
  git(seed, ["push", remote, "main"]);
}

function age(path: string, ms: number): void {
  const past = new Date(Date.now() - ms);
  utimesSync(path, past, past);
}

function synced(project: string, runner: Parameters<typeof syncTrees>[3]): string {
  const result = syncTrees(project, undefined, false, runner, 0).connections[0];
  if (!result?.ok || !result.repository) throw new Error(`Expected a synced snapshot: ${JSON.stringify(result)}`);
  return result.repository.root;
}

describe("snapshot eviction", () => {
  it("keeps a superseded snapshot through the retention window and removes it afterwards", () => {
    const { project, home } = fixture();
    const { runner, seed, remote } = remoteFixture(home);
    const first = connectTree(project, source, runner).repository?.root ?? "";
    advance(seed, remote, "Second");
    const second = synced(project, runner);
    expect(second).not.toBe(first);
    expect(existsSync(first)).toBe(true);

    age(first, SNAPSHOT_RETENTION_MS - 60_000);
    expect(synced(project, runner)).toBe(second);
    expect(existsSync(first)).toBe(true);

    age(first, SNAPSHOT_RETENTION_MS + 60_000);
    age(second, SNAPSHOT_RETENTION_MS + 60_000);
    expect(synced(project, runner)).toBe(second);
    expect(existsSync(first)).toBe(false);
    expect(existsSync(second)).toBe(true);
    const repository = git(second, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
    expect(git(repository, ["worktree", "list", "--porcelain"])).not.toContain(first);
  });

  it("preserves modified, locked, and write-session worktrees", () => {
    const { project, home } = fixture();
    const { runner, seed, remote } = remoteFixture(home);
    const modified = connectTree(project, source, runner).repository?.root ?? "";
    advance(seed, remote, "Second");
    const locked = synced(project, runner);
    const session = prepareWrite(project, undefined, runner);
    advance(seed, remote, "Third");
    synced(project, runner);

    writeFileSync(join(modified, "docs/pending.md"), node("Pending"));
    mkdirSync(join(session.worktreeRoot, "docs/extra"), { recursive: true });
    for (const path of [modified, locked, session.worktreeRoot]) age(path, 2 * SNAPSHOT_RETENTION_MS);
    withLock(`${locked}.lock`, () => synced(project, runner));

    expect(existsSync(join(modified, "docs/pending.md"))).toBe(true);
    expect(existsSync(locked)).toBe(true);
    expect(existsSync(session.worktreeRoot)).toBe(true);
    abortWrite(session.id, runner);
  });

  it("does not evict during offline sync", () => {
    const { project, home } = fixture();
    const { runner, seed, remote } = remoteFixture(home);
    const first = connectTree(project, source, runner).repository?.root ?? "";
    advance(seed, remote, "Second");
    synced(project, runner);
    age(first, 2 * SNAPSHOT_RETENTION_MS);
    syncTrees(project, undefined, true, runner);
    expect(existsSync(first)).toBe(true);
  });

  it("records a use when reading an explicit path inside a snapshot", () => {
    const { project, home } = fixture();
    const { runner } = remoteFixture(home);
    const tree = connectTree(project, source, runner);
    const root = tree.repository?.root ?? "";
    age(root, 2 * SNAPSHOT_RETENTION_MS);
    touchSnapshotContaining(join(tree.treeRoot, "NODE.md"));
    expect(Date.now() - statSync(root).mtimeMs).toBeLessThan(SNAPSHOT_RETENTION_MS);
    age(root, 2 * SNAPSHOT_RETENTION_MS);
    touchSnapshotContaining(project);
    expect(Date.now() - statSync(root).mtimeMs).toBeGreaterThan(SNAPSHOT_RETENTION_MS);
  });
});
