import { lstatSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import { type CommandRunner, git, gitRaw, optionalGit } from "../adapters/git.js";
import { stateDirectory, withLock } from "../adapters/state.js";
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
import { identityId } from "./identity.js";

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
export function managedRepository(
  source: Extract<TreeSource, { kind: "git" }>,
  sync: boolean,
  runner?: CommandRunner,
): { root: string; sha: string } {
  const parent = stateDirectory("repositories");
  const root = join(parent, `${identityId(source.repository)}.git`);
  return withLock(`${root}.lock`, () => {
    const expected = `https://github.com/${githubRepositoryIdentitySchema.parse(source.repository)}.git`;
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      if (!sync) throw new Error("Git source is not cached; run context-tree sync.");
      try {
        git(parent, ["clone", "--bare", "--quiet", "--", expected, root], { runner });
      } catch (error) {
        rmSync(root, { recursive: true, force: true });
        throw error;
      }
    }
    realDirectoryWithoutSymlinks(root, "Repository cache");
    if (
      git(root, ["rev-parse", "--is-bare-repository"], { runner }) !== "true" ||
      git(root, ["remote", "get-url", "origin"], { runner }) !== expected
    )
      throw new Error("Repository cache identity changed.");
    const ref = `refs/remotes/origin/${source.ref}`;
    if (sync) git(root, ["fetch", "--quiet", "--no-tags", "origin", `+refs/heads/${source.ref}:${ref}`], { runner });
    const sha = git(root, ["rev-parse", "--verify", `${ref}^{commit}`], { runner });
    return { root, sha };
  });
}

function snapshot(
  source: Extract<TreeSource, { kind: "git" }>,
  repository: { root: string; sha: string },
  runner?: CommandRunner,
): string {
  const root = join(stateDirectory("snapshots"), `${identityId(source.repository)}-${repository.sha}`);
  return withLock(`${root}.lock`, () => {
    if (!lstatSync(root, { throwIfNoEntry: false })) {
      git(repository.root, ["worktree", "add", "--quiet", "--detach", root, repository.sha], { runner });
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
    return canonical;
  });
}

export function resolveSource(connection: Connection, sync = false, runner?: CommandRunner): ResolvedTree {
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
  const repository = managedRepository(source, sync, runner);
  const root = snapshot(source, repository, runner);
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
