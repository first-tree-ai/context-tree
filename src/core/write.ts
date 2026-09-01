import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  CLI_ERROR_CODES,
  type FinishContextWriteResult,
  type PrepareContextWriteResult,
  SCHEMA_VERSION,
} from "../schemas.js";
import { resolveConnectionRecord } from "./connections.js";
import { ContextTreeError } from "./internal/errors.js";
import { CommandError, type CommandRunner, git, optionalGit } from "./internal/git.js";
import { realDirectoryWithoutSymlinks } from "./path.js";
import { syncProject } from "./sync.js";
import { verifyTree } from "./verify.js";

const TASK_BRANCH_PREFIX = "context-tree/write/";
/** A prepared worktree left untouched for longer than this is treated as abandoned. */
const ABANDONED_WRITE_AGE_MS = 24 * 60 * 60 * 1000;

/** Synchronize first, then create an isolated task worktree at the exact HEAD. */
export function prepareContextWrite(projectPath: string, runner?: CommandRunner): PrepareContextWriteResult {
  const synchronized = syncProject(projectPath, runner);
  const root = synchronized.tree.path;
  reclaimAbandonedWrites(root, synchronized.branch, runner);
  const destination = mkdtempSync(join(tmpdir(), "context-tree-write-"));
  const taskBranch = `${TASK_BRANCH_PREFIX}${basename(destination)}`;
  try {
    git(root, ["worktree", "add", "--quiet", "-b", taskBranch, destination, synchronized.sha], {
      message: "Creating the isolated write worktree failed.",
      runner,
    });
    return { schemaVersion: SCHEMA_VERSION, worktreePath: realDirectoryWithoutSymlinks(destination, "Write worktree") };
  } catch (error) {
    rmSync(destination, { force: true, recursive: true });
    throw error;
  }
}

export type FinishContextWriteOptions = {
  message: string;
  projectPath: string;
  worktreePath: string;
};

/** Commit every pending change, then fast-forward locally or push once. */
export function finishContextWrite(
  options: FinishContextWriteOptions,
  runner?: CommandRunner,
): FinishContextWriteResult {
  const connection = resolveConnectionRecord(options.projectPath, runner);
  const root = connection.tree.path;
  const { taskBranch, worktreePath } = validatePreparedWorktree(root, options.worktreePath, runner);
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the connected checkout branch.",
    runner,
  });

  const status = git(worktreePath, ["status", "--porcelain", "--untracked-files=all"], {
    message: "Failed to inspect the prepared worktree.",
    runner,
  });
  if (status.length === 0) throw new Error("The prepared worktree has no pending changes.");
  if (!verifyTree(worktreePath).ok) {
    throw new ContextTreeError(
      CLI_ERROR_CODES.invalidTree,
      `Refusing to commit an invalid Context Tree; run context-tree verify --tree-path ${worktreePath}.`,
    );
  }

  git(worktreePath, ["add", "--all"], { message: "Staging the Context Tree changes failed.", runner });
  git(worktreePath, ["-c", "commit.gpgsign=false", "commit", "--quiet", "-m", options.message], {
    message: "Committing the Context Tree changes failed.",
    runner,
  });
  const sha = git(worktreePath, ["rev-parse", "HEAD"], {
    message: "Failed to resolve the write commit.",
    runner,
  });

  try {
    if (connection.tree.kind === "local") {
      git(root, ["merge", "--ff-only", taskBranch], {
        message: "Fast-forwarding the local Context Tree failed.",
        runner,
      });
    } else {
      git(worktreePath, ["push", "origin", `HEAD:refs/heads/${branch}`], {
        message: "Publishing the Context Tree write failed.",
        runner,
      });
    }
  } catch (error) {
    if (isNonFastForward(error)) {
      throw new ContextTreeError(
        CLI_ERROR_CODES.writeOutdated,
        `The Context Tree advanced; the prepared worktree is preserved at ${worktreePath}.`,
      );
    }
    throw error;
  }

  removeWorktree(root, worktreePath, taskBranch, runner);
  return { branch, schemaVersion: SCHEMA_VERSION, sha };
}

function gitCommonDirectory(root: string, runner?: CommandRunner): string {
  const value = git(root, ["rev-parse", "--git-common-dir"], {
    message: "Failed to resolve the Git common directory.",
    runner,
  });
  return realDirectoryWithoutSymlinks(isAbsolute(value) ? value : resolve(root, value), "Git common directory");
}

function validatePreparedWorktree(
  root: string,
  suppliedPath: string,
  runner?: CommandRunner,
): { taskBranch: string; worktreePath: string } {
  const worktreePath = realDirectoryWithoutSymlinks(suppliedPath, "Prepared worktree");
  if (gitCommonDirectory(worktreePath, runner) !== gitCommonDirectory(root, runner)) {
    throw new Error("The prepared worktree does not belong to the connected Context Tree.");
  }
  const taskBranch = git(worktreePath, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the worktree branch.",
    runner,
  });
  if (!taskBranch.startsWith(TASK_BRANCH_PREFIX)) {
    throw new Error("The prepared worktree is not on a reserved Context Tree write branch.");
  }
  return { taskBranch, worktreePath };
}

function isNonFastForward(error: unknown): boolean {
  return (
    error instanceof CommandError &&
    /non-fast-forward|fetch first|tip of your current branch is behind|not possible to fast-forward|diverg/i.test(
      error.stderr,
    )
  );
}

function removeWorktree(root: string, worktreePath: string, taskBranch: string, runner?: CommandRunner): void {
  git(root, ["worktree", "remove", worktreePath], { message: "Removing the write worktree failed.", runner });
  git(root, ["branch", "-D", taskBranch], { message: "Deleting the write branch failed.", runner });
}

/** Map every reserved write branch that still has a registered worktree to its path. */
function listWriteWorktrees(root: string, runner?: CommandRunner): Map<string, string> {
  const paths = new Map<string, string>();
  const output = optionalGit(root, ["worktree", "list", "--porcelain"], runner);
  if (output === undefined) return paths;
  let path: string | undefined;
  for (const record of output.split("\n")) {
    if (record.startsWith("worktree ")) {
      path = record.slice("worktree ".length).trim();
      continue;
    }
    if (!record.startsWith("branch refs/heads/")) continue;
    const branch = record.slice("branch refs/heads/".length).trim();
    if (path !== undefined && branch.startsWith(TASK_BRANCH_PREFIX)) paths.set(branch, path);
  }
  return paths;
}

function millisecondsSinceModification(path: string): number | undefined {
  try {
    return Date.now() - statSync(path).mtimeMs;
  } catch {
    return undefined;
  }
}

/**
 * A preparation is abandoned only when it carries no commit the connected
 * checkout lacks, has no pending edits, and has gone untouched. Every unknown
 * answer preserves the worktree, so a `WRITE_OUTDATED` commit awaiting its
 * retry and a concurrent preparation both survive.
 */
function isAbandonedWrite(
  root: string,
  branch: string,
  checkoutBranch: string,
  path: string | undefined,
  runner?: CommandRunner,
): boolean {
  if (optionalGit(root, ["rev-list", "--count", branch, "--not", checkoutBranch], runner) !== "0") return false;
  if (path === undefined) return true;
  const age = millisecondsSinceModification(path);
  if (age === undefined || age < ABANDONED_WRITE_AGE_MS) return false;
  return optionalGit(path, ["status", "--porcelain", "--untracked-files=all"], runner) === "";
}

/** Reclaim earlier preparations that were never finished. Every step is best effort. */
function reclaimAbandonedWrites(root: string, checkoutBranch: string, runner?: CommandRunner): void {
  optionalGit(root, ["worktree", "prune"], runner);
  const paths = listWriteWorktrees(root, runner);
  const branches = optionalGit(
    root,
    ["for-each-ref", "--format=%(refname:short)", `refs/heads/${TASK_BRANCH_PREFIX}`],
    runner,
  );
  if (branches === undefined) return;
  for (const branch of branches.split("\n").filter((value) => value.length > 0)) {
    const path = paths.get(branch);
    if (!isAbandonedWrite(root, branch, checkoutBranch, path, runner)) continue;
    if (path !== undefined) optionalGit(root, ["worktree", "remove", path], runner);
    optionalGit(root, ["branch", "-D", branch], runner);
  }
}
