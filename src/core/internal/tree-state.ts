import { lstatSync, realpathSync } from "node:fs";
import { join } from "node:path";
import type { ContextTreeState } from "../../schemas.js";
import { CLI_ERROR_CODES, parseContextTreeRootNode } from "../../schemas.js";
import { realDirectoryWithoutSymlinks } from "../path.js";
import { verifyTree } from "../verify.js";
import { ContextTreeError } from "./errors.js";
import { readUtf8File } from "./filesystem.js";
import { type CommandRunner, git, optionalGit } from "./git.js";

/**
 * The one tree-state resolver shared by create, connect, sync, publish, and
 * writes. It validates a checkout exactly once and reports the discriminated
 * tree state: a local-only tree, or a published tree with its GitHub
 * OWNER/REPO identity. Resolution never backfills or mutates stored state.
 */

/** Require a real directory with no symlink component that is an exact Git root. */
function exactGitRoot(treePath: string, runner?: CommandRunner): string {
  const root = realDirectoryWithoutSymlinks(treePath, "Context Tree path");
  const toplevel = optionalGit(root, ["rev-parse", "--show-toplevel"], runner);
  if (toplevel === undefined || toplevel.length === 0) {
    throw new Error("Context Tree path must be a Git repository.");
  }
  if (realpathSync(toplevel) !== root) {
    throw new Error("Context Tree path must be the real Git root.");
  }
  return root;
}

/** Parse the root NODE.md, refusing symlinked or irregular files. */
export function parseRootNode(root: string): ReturnType<typeof parseContextTreeRootNode> {
  const path = join(root, "NODE.md");
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Context Tree root NODE.md must be a regular file.");
  }
  return parseContextTreeRootNode(readUtf8File(path));
}

/**
 * Validate a clean checkout without inferring state from mutable Git remotes.
 * Uncommitted changes and invalid content each get their own code so callers
 * can tell "commit your edits" apart from "this path is gone".
 */
export function validateTreeCheckout(treePath: string, runner?: CommandRunner): string {
  const root = exactGitRoot(treePath, runner);
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"], {
    message: "Failed to inspect Context Tree cleanliness.",
    runner,
  });
  if (status.trim().length !== 0) {
    throw new ContextTreeError(
      CLI_ERROR_CODES.dirtyTree,
      `The Context Tree at ${root} has uncommitted changes; commit or discard them.`,
    );
  }
  if (!verifyTree(root).ok) {
    throw new ContextTreeError(
      CLI_ERROR_CODES.invalidTree,
      `The Context Tree at ${root} is invalid; run context-tree verify --tree-path ${root}.`,
    );
  }
  return root;
}

/** Validate a stored state without reclassifying it from mutable Git remotes. */
export function validateStoredTreeState(state: ContextTreeState, runner?: CommandRunner): ContextTreeState {
  const path = validateTreeCheckout(state.path, runner);
  return state.kind === "local" ? { kind: "local", path } : { kind: "github", path, repository: state.repository };
}
