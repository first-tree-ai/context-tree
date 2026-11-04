import { lstatSync, realpathSync, renameSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type CommandRunner, git, gitRaw, optionalGit } from "../adapters/git.js";
import { atomicState, readState, stateDirectory, withLockWait } from "../adapters/state.js";
import {
  CLI_ERROR_CODES,
  type Connection,
  githubRepositoryIdentitySchema,
  type ResolvedTree,
  type TreeSource,
} from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { isPathInside, realDirectoryWithoutSymlinks, toPosixPath } from "../tree/path.js";
import { readRootNode } from "../tree/root.js";
import { verifyTree } from "../tree/verify.js";
import { evictIdleSnapshots, touchSnapshot } from "./eviction.js";
import { identityId } from "./identity.js";
import { addManagedWorktree } from "./worktree.js";

export function validateTree(root: string): void {
  const report = verifyTree(root);
  if (!report.ok)
    throw new ContextTreeError(
      CLI_ERROR_CODES.invalidTree,
      `Invalid Context Tree at ${root}: ${report.findings.map((finding) => `${finding.path}: ${finding.message}`).join("; ")}`,
    );
}
export function directoryRoot(connection: Connection): string {
  if (connection.source.kind !== "directory") throw new Error("Expected a directory source.");
  const path = resolve(connection.projectRoot, connection.source.path);
  if (!isAbsolute(connection.source.path) && !isPathInside(connection.projectRoot, path))
    throw new Error("Directory source escapes the project.");
  return realDirectoryWithoutSymlinks(path, "Tree root");
}
export function inspectRepository(treeRoot: string, runner?: CommandRunner): ResolvedTree["repository"] {
  const top = optionalGit(treeRoot, ["rev-parse", "--show-toplevel"], runner);
  if (!top) return null;
  const root = realDirectoryWithoutSymlinks(top, "Repository root");
  return {
    root,
    directory: toPosixPath(relative(root, treeRoot)) || ".",
    sha: optionalGit(root, ["rev-parse", "--verify", "HEAD"], runner) ?? "unborn",
    branch: optionalGit(root, ["symbolic-ref", "--short", "HEAD"], runner) ?? null,
  };
}
export function repositoryDirty(root: string, directory: string, runner?: CommandRunner): boolean {
  return (
    gitRaw(root, ["status", "--porcelain", "--untracked-files=all", "--", literalPathspec(directory)], { runner })
      .length > 0
  );
}
export function literalPathspec(directory: string): string {
  return directory === "." ? ":(top)**" : `:(top,literal)${directory}`;
}

/** One bare cache per repository; refs and snapshots do not share a working index. */
/** A fetch younger than this is reused instead of contacting the remote again. */
export const FETCH_FRESHNESS_MS = 60_000;

export function managedRepository(
  source: Extract<TreeSource, { kind: "git" }>,
  sync: boolean,
  runner?: CommandRunner,
  maxAgeMs: number = FETCH_FRESHNESS_MS,
): { root: string; sha: string } {
  const parent = stateDirectory("repositories");
  const root = repositoryCacheRoot(source);
  return withLockWait(`${root}.lock`, () => {
    const expected = `https://github.com/${githubRepositoryIdentitySchema.parse(source.repository)}.git`;
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      if (!sync) throw new Error("Git source is not cached; run context-tree sync.");
      // A killed clone must never become the canonical repository cache. This staging
      // directory cannot contain a published snapshot or a user's write session.
      const staging = `${root}.clone`;
      rmSync(staging, { recursive: true, force: true });
      try {
        git(parent, ["clone", "--bare", "--quiet", "--filter=tree:0", "--", expected, staging], { runner });
        renameSync(staging, root);
      } finally {
        rmSync(staging, { recursive: true, force: true });
      }
    }
    realDirectoryWithoutSymlinks(root, "Repository cache");
    if (
      git(root, ["rev-parse", "--is-bare-repository"], { runner }) !== "true" ||
      git(root, ["config", "--local", "--get", "remote.origin.url"], { runner }) !== expected
    )
      throw new Error("Repository cache identity changed.");
    const ref = `refs/remotes/origin/${source.ref}`;
    if (sync && !fetchedRecently(root, ref, maxAgeMs, runner)) {
      git(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${source.ref}:${ref}`], { runner });
      recordFetch(root, ref);
    }
    const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`], { runner });
    return { root, sha };
  });
}

function repositoryCacheRoot(source: Extract<TreeSource, { kind: "git" }>): string {
  return join(stateDirectory("repositories"), `${identityId(source.repository)}.git`);
}

/**
 * Advance the cache's remote-tracking ref to a commit this machine just pushed.
 *
 * The push proves the remote branch pointed at `published` at that moment, so it counts as a
 * fresh fetch and a sync within the window resolves the published commit. The ref moves only
 * from `previous` (compare-and-swap under the cache lock). If the ref holds anything else, its
 * fetch record is dropped so the next sync fetches instead of trusting the cache.
 */
export function recordPublished(
  source: Extract<TreeSource, { kind: "git" }>,
  previous: string,
  published: string,
  runner?: CommandRunner,
): void {
  const root = repositoryCacheRoot(source);
  withLockWait(`${root}.lock`, () => {
    const ref = `refs/remotes/origin/${source.ref}`;
    const current = optionalGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], runner);
    if (current === published) return recordFetch(root, ref);
    if (current === previous) {
      try {
        git(root, ["update-ref", "-m", "context-tree: publish", ref, published, previous], { runner });
        return recordFetch(root, ref);
      } catch {
        // The ref moved concurrently; the next sync fetches rather than trusting it.
      }
    }
    forgetFetch(root, ref);
  });
}

/** Fetch times per remote-tracking ref, shared by every process using this cache. */
function fetchState(root: string): string {
  return `${root}.fetched.json`;
}
function fetchedRecently(root: string, ref: string, maxAgeMs: number, runner?: CommandRunner): boolean {
  if (maxAgeMs <= 0) return false;
  let fetched: unknown;
  try {
    fetched = readState(fetchState(root));
  } catch {
    return false;
  }
  const at = fetched && typeof fetched === "object" ? Object.getOwnPropertyDescriptor(fetched, ref)?.value : undefined;
  if (typeof at !== "number" || !(Date.now() - at < maxAgeMs && at <= Date.now())) return false;
  return optionalGit(root, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`], runner) !== undefined;
}
function fetchRecords(root: string): Record<string, unknown> {
  try {
    const state = readState(fetchState(root));
    if (state && typeof state === "object" && !Array.isArray(state)) return { ...state };
  } catch {
    // An unreadable record is replaced.
  }
  return {};
}
function recordFetch(root: string, ref: string): void {
  atomicState(fetchState(root), { ...fetchRecords(root), [ref]: Date.now() });
}
function forgetFetch(root: string, ref: string): void {
  const { [ref]: _forgotten, ...rest } = fetchRecords(root);
  atomicState(fetchState(root), rest);
}

function snapshot(
  source: Extract<TreeSource, { kind: "git" }>,
  repository: { root: string; sha: string },
  runner?: CommandRunner,
): string {
  const key = identityId(JSON.stringify([source.repository.toLowerCase(), source.path]));
  const root = join(stateDirectory("snapshots"), `${key}-${repository.sha}`);
  return withLockWait(`${root}.lock`, () => {
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      addManagedWorktree(repository, root, source.path, undefined, runner);
    }
    const canonical = realDirectoryWithoutSymlinks(root, "Snapshot");
    const common = git(canonical, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { runner });
    if (
      realpathSync(common) !== realpathSync(repository.root) ||
      git(canonical, ["rev-parse", "HEAD"], { runner }) !== repository.sha
    )
      throw new Error("Snapshot identity changed.");
    if (repositoryDirty(canonical, ".", runner) || gitRaw(canonical, ["ls-files", "--others", "-z"], { runner }).length)
      throw new ContextTreeError(
        CLI_ERROR_CODES.dirtyTree,
        "A cached snapshot was modified; it is preserved for recovery.",
      );
    touchSnapshot(canonical);
    return canonical;
  });
}

export function resolveSource(
  connection: Connection,
  sync = false,
  runner?: CommandRunner,
  maxAgeMs: number = FETCH_FRESHNESS_MS,
): ResolvedTree {
  if (connection.source.kind === "directory") {
    const treeRoot = directoryRoot(connection);
    readRootNode(treeRoot);
    if (sync) validateTree(treeRoot);
    const repository = inspectRepository(treeRoot, runner);
    return {
      connection,
      treeRoot,
      repository,
      dirty: repository ? repositoryDirty(repository.root, repository.directory, runner) : false,
    };
  }
  const source = connection.source;
  const repository = managedRepository(source, sync, runner, maxAgeMs);
  const root = snapshot(source, repository, runner);
  if (sync) evictIdleSnapshots(repository, root, runner);
  const treeRoot = realDirectoryWithoutSymlinks(join(root, source.path), "Tree root");
  if (!isPathInside(root, treeRoot)) throw new Error("Tree escapes repository.");
  // A submodule or nested Git checkout cannot silently change repository ownership.
  const actual = inspectRepository(treeRoot, runner);
  if (actual?.root !== root) throw new Error("Tree belongs to a nested repository.");
  readRootNode(treeRoot);
  if (sync) validateTree(treeRoot);
  return {
    connection,
    treeRoot,
    repository: { root, directory: source.path, sha: repository.sha, branch: source.ref },
    dirty: false,
  };
}
