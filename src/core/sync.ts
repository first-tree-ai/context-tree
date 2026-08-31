import type { ContextTreeSyncResult } from "../schemas.js";
import { SCHEMA_VERSION } from "../schemas.js";
import { resolveConnectionRecord } from "./connections.js";
import { type CommandRunner, git } from "./internal/git.js";
import { validateStoredTreeState } from "./internal/tree-state.js";

/**
 * Local trees report their checked-out state without network access. GitHub
 * trees fast-forward the exact checked-out branch once, then revalidate.
 */
export function syncProject(projectPath: string, runner?: CommandRunner): ContextTreeSyncResult {
  const connection = resolveConnectionRecord(projectPath, runner);
  const root = connection.tree.path;
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the checked-out branch.",
    runner,
  });
  if (connection.tree.kind === "github") {
    git(root, ["pull", "--ff-only", "origin", branch], {
      message: "Fast-forwarding the Context Tree failed.",
      runner,
    });
    validateStoredTreeState(connection.tree, runner);
  }
  const sha = git(root, ["rev-parse", "HEAD"], { message: "Failed to resolve the Context Tree commit.", runner });
  return {
    branch,
    schemaVersion: SCHEMA_VERSION,
    sha,
    tree: connection.tree,
  };
}
