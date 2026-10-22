import { randomUUID } from "node:crypto";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { type CommandRunner, git, gitRaw } from "../adapters/git.js";
import { atomicState, readState, stateDirectory, withLock } from "../adapters/state.js";
import {
  CLI_ERROR_CODES,
  type FinishWriteResult,
  SCHEMA_VERSION,
  type WriteSession,
  writeSessionSchema,
} from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { sourceSelector } from "../sources/identity.js";
import { directoryRoot, inspectRepository, literalPathspec, resolveSource, validateTree } from "../sources/resolve.js";
import { realDirectoryWithoutSymlinks } from "../tree/path.js";
import { connection } from "./connections.js";

function sessionPath(id: string): string {
  if (!/^[a-f\d-]{36}$/u.test(id)) throw new Error("Invalid write session ID.");
  return join(stateDirectory("sessions"), `${id}.json`);
}
export function loadWriteSession(id: string): WriteSession {
  const session = writeSessionSchema.parse(readState(sessionPath(id)));
  if (session.id !== id) throw new Error("Write session identity changed.");
  return session;
}
function save(session: WriteSession): void {
  atomicState(sessionPath(session.id), writeSessionSchema.parse(session));
}
function commonDirectory(root: string, runner?: CommandRunner): string {
  return realDirectoryWithoutSymlinks(
    git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"], { runner }),
    "Git common directory",
  );
}
export function prepareWrite(project: string, selector?: string, runner?: CommandRunner): WriteSession {
  const selected = connection(project, selector, runner);
  const resolved = resolveSource(selected, true, runner);
  const repository = resolved.repository;
  if (!repository || repository.sha === "unborn")
    throw new Error(
      "Isolated edits require a committed Git repository. For local edits, edit the tree directly and run verify.",
    );
  if (resolved.dirty)
    throw new ContextTreeError(
      CLI_ERROR_CODES.dirtyTree,
      "Commit the tree's pending edits before an isolated write; unrelated project edits may remain.",
    );
  const id = randomUUID();
  const worktreeRoot = join(stateDirectory("worktrees"), id);
  const taskBranch = `context-tree/write/${id}`;
  git(repository.root, ["worktree", "add", "--quiet", "-b", taskBranch, worktreeRoot, repository.sha], { runner });
  const session: WriteSession = {
    schemaVersion: SCHEMA_VERSION,
    id,
    connection: selected,
    treeRoot: realDirectoryWithoutSymlinks(join(worktreeRoot, repository.directory), "Editable tree"),
    repository: {
      ...repository,
      root: selected.source.kind === "git" ? commonDirectory(repository.root, runner) : repository.root,
    },
    worktreeRoot,
    taskBranch,
    commit: null,
  };
  save(session);
  return session;
}
function assertConnection(session: WriteSession, runner?: CommandRunner): void {
  const current = connection(
    session.connection.projectRoot,
    sourceSelector(session.connection.projectRoot, session.connection.source),
    runner,
  );
  if (current.source.kind === "directory") {
    const root = directoryRoot(current);
    const repository = inspectRepository(root, runner);
    if (
      JSON.stringify(repository && [repository.root, repository.branch, repository.directory]) !==
      JSON.stringify([session.repository.root, session.repository.branch, session.repository.directory])
    )
      throw new Error("Project repository or branch changed; edits are preserved.");
  }
}
/** Read every pending path, including pre-staged, untracked, ignored, renamed, and deleted files. */
export function changedPaths(root: string, runner?: CommandRunner): string[] {
  return [
    ...new Set(
      [
        ...gitRaw(root, ["diff", "--no-renames", "--name-only", "-z"], { runner }).split("\0"),
        ...gitRaw(root, ["diff", "--cached", "--no-renames", "--name-only", "-z"], { runner }).split("\0"),
        ...gitRaw(root, ["ls-files", "--others", "-z"], { runner }).split("\0"),
      ].filter(Boolean),
    ),
  ];
}
export function assertScope(paths: string[], directory: string): void {
  if (paths.some((path) => directory !== "." && path !== directory && !path.startsWith(`${directory}/`)))
    throw new ContextTreeError(
      CLI_ERROR_CODES.scopeViolation,
      "The write changed files outside its tree; worktree preserved.",
    );
}
function assertIsolated(session: WriteSession, runner?: CommandRunner): { root: string; directory: string } {
  const { repository, worktreeRoot, taskBranch } = session;
  const root = realDirectoryWithoutSymlinks(worktreeRoot, "Write worktree");
  if (
    commonDirectory(root, runner) !== commonDirectory(repository.root, runner) ||
    git(root, ["symbolic-ref", "--short", "HEAD"], { runner }) !== taskBranch ||
    git(root, ["rev-parse", "HEAD"], { runner }) !== (session.commit ?? repository.sha) ||
    realDirectoryWithoutSymlinks(join(root, repository.directory), "Editable tree") !== session.treeRoot
  )
    throw new Error("Prepared Git state changed; worktree preserved.");
  return { root, directory: repository.directory };
}
function removeSession(session: WriteSession, runner?: CommandRunner): void {
  git(session.repository.root, ["worktree", "remove", session.worktreeRoot], { runner });
  git(session.repository.root, ["branch", "-D", session.taskBranch], { runner });
  rmSync(sessionPath(session.id));
}
export function finishWrite(id: string, message: string, publish = false, runner?: CommandRunner): FinishWriteResult {
  return withLock(`${sessionPath(id)}.lock`, () => {
    const session = loadWriteSession(id);
    assertConnection(session, runner);
    if (publish && session.connection.source.kind !== "git")
      throw new Error("Directory sources use the host's Git workflow; Context Tree cannot publish them.");
    const { root, directory } = assertIsolated(session, runner);
    const pending = changedPaths(root, runner);
    assertScope(pending, directory);
    validateTree(session.treeRoot);
    if (session.commit && pending.length) throw new Error("Committed session has new edits; worktree preserved.");
    if (!session.commit) {
      if (pending.length === 0) {
        removeSession(session, runner);
        return {
          schemaVersion: SCHEMA_VERSION,
          outcome: "unchanged",
          treeRoot: session.treeRoot,
          branch: null,
          sha: null,
          sessionId: null,
        };
      }
      if (!message.trim()) throw new Error("A commit message is required.");
      git(root, ["add", "--all", "--", literalPathspec(directory)], { runner });
      const staged = gitRaw(root, ["diff", "--cached", "--no-renames", "--name-only", "-z"], { runner })
        .split("\0")
        .filter(Boolean);
      assertScope(staged, directory);
      if (staged.length === 0 || pending.some((path) => !staged.includes(path)))
        throw new Error("Some edits cannot be staged (possibly ignored files); worktree preserved.");
      git(root, ["commit", "--quiet", "-m", message], { runner });
      session.commit = git(root, ["rev-parse", "HEAD"], { runner });
      save(session);
    }
    const repository = session.repository;
    const changed = gitRaw(root, ["diff", "--no-renames", "--name-only", "-z", repository.sha, session.commit], {
      runner,
    })
      .split("\0")
      .filter(Boolean);
    assertScope(changed, directory);
    if (git(root, ["rev-parse", `${session.commit}^`], { runner }) !== repository.sha)
      throw new Error("Commit parent changed; worktree preserved.");
    if (changedPaths(root, runner).length) throw new Error("Commit left pending edits; worktree preserved.");
    validateTree(session.treeRoot);
    if (!publish)
      return {
        schemaVersion: SCHEMA_VERSION,
        outcome: "committed",
        treeRoot: session.treeRoot,
        branch: session.taskBranch,
        sha: session.commit,
        sessionId: id,
      };
    const source = session.connection.source;
    if (source.kind !== "git") throw new Error("Only Git sources can be published.");
    // Remote identity and the exact target ref are rechecked; no force push or branch inference.
    const origin = git(root, ["config", "--local", "--get", "remote.origin.url"], { runner });
    if (origin !== `https://github.com/${source.repository}.git`)
      throw new Error("Remote identity changed; worktree preserved.");
    try {
      git(root, ["push", "origin", `HEAD:refs/heads/${source.ref}`], { runner });
    } catch (error) {
      if (
        error instanceof Error &&
        /non-fast-forward|fetch first|tip of your current branch is behind/iu.test(error.message)
      )
        throw new ContextTreeError(CLI_ERROR_CODES.writeOutdated, `The target advanced; session ${id} is preserved.`);
      throw error;
    }
    const result: FinishWriteResult = {
      schemaVersion: SCHEMA_VERSION,
      outcome: "published",
      treeRoot: session.treeRoot,
      branch: source.ref,
      sha: session.commit,
      sessionId: null,
    };
    removeSession(session, runner);
    return result;
  });
}
/** Remove an isolated preparation only when it contains no work. */
export function abortWrite(id: string, runner?: CommandRunner): void {
  withLock(`${sessionPath(id)}.lock`, () => {
    const session = loadWriteSession(id);
    const { root } = assertIsolated(session, runner);
    if (session.commit || changedPaths(root, runner).length) throw new Error("Session contains work; it is preserved.");
    removeSession(session, runner);
  });
}
