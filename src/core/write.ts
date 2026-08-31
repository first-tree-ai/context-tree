import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve } from "node:path";

import {
  CLI_ERROR_CODES,
  type FinishContextWriteResult,
  type PrepareContextWriteResult,
  SCHEMA_VERSION,
} from "../schemas.js";
import { ConnectionError, resolveConnectionRecord } from "./connections.js";
import { CommandError, type CommandRunner, git } from "./internal/git.js";
import { realDirectoryWithoutSymlinks } from "./path.js";
import { syncProject } from "./sync.js";
import { verifyTree } from "./verify.js";

const TASK_BRANCH_PREFIX = "context-tree/write/";

/** Synchronize first, then create an isolated task worktree at the exact HEAD. */
export function prepareContextWrite(projectPath: string, runner?: CommandRunner): PrepareContextWriteResult {
  const synchronized = syncProject(projectPath, runner);
  const root = synchronized.tree.path;
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
    throw new Error("Refusing to commit an invalid Context Tree; run context-tree verify.");
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
      throw new ConnectionError(
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
