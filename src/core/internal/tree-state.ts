import { lstatSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ContextTreeState } from "../../schemas.js";
import { parseContextTreeRootNode } from "../../schemas.js";
import { verifyTree } from "../verify.js";
import { readUtf8File } from "./filesystem.js";
import { type CommandRunner, git, optionalGit } from "./git.js";
import { repositoryIdentityFromGitHubUrl } from "./github-repository.js";

/**
 * The one tree-state resolver shared by setup, connect, sync, publish, and
 * writes. It validates a checkout exactly once and reports the discriminated
 * tree state: a local-only tree, or a published tree with its GitHub
 * OWNER/REPO identity. Resolution never backfills or mutates stored state.
 */

/** Require a real directory with no symlink component that is an exact Git root. */
export function exactGitRoot(treePath: string): string {
  const absolute = resolve(treePath);
  const entry = lstatSync(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink()) {
    throw new Error("Context Tree path must be a real directory with no symlink component.");
  }
  const root = realpathSync(absolute);
  const toplevel = optionalGit(root, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined || toplevel.length === 0) {
    throw new Error("Context Tree path must be a Git repository.");
  }
  if (realpathSync(toplevel) !== root) {
    throw new Error("Context Tree path must be the real Git root.");
  }
  return root;
}

/** Require a clean working tree, including untracked files. */
export function requireCleanTree(root: string, runner?: CommandRunner): void {
  const status = git(root, ["status", "--porcelain", "--untracked-files=all"], {
    message: "Failed to inspect Context Tree cleanliness.",
    runner,
  });
  if (status.trim().length !== 0) throw new Error("Context Tree checkout must be clean.");
}

/** The GitHub OWNER/REPO identity of the checkout origin, or undefined for local-only trees. */
export function checkoutRepositoryIdentity(root: string, runner?: CommandRunner): string | undefined {
  const origin = optionalGit(root, ["remote", "get-url", "origin"], runner);
  if (origin === undefined || origin.length === 0) return undefined;
  return repositoryIdentityFromGitHubUrl(origin);
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
 * Validate the checkout completely and return its discriminated state. The
 * repository identity comes from the live checkout origin only; a local-only
 * tree stays local until publication updates the link.
 */
export function resolveTreeState(treePath: string, runner?: CommandRunner): ContextTreeState {
  const root = exactGitRoot(treePath);
  requireCleanTree(root, runner);
  const repository = checkoutRepositoryIdentity(root, runner);
  const verification = verifyTree(root);
  if (!verification.ok) {
    throw new Error("Context Tree checkout is invalid; run context-tree verify.");
  }
  parseRootNode(root);
  return repository === undefined ? { kind: "local", path: root } : { kind: "github", path: root, repository };
}
