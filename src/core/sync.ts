import type { ContextTreeSyncResult, ContextTreeSyncSnapshot } from "../schemas.js";
import { CLI_ERROR_CODES, CONNECTION_SCHEMA_VERSION } from "../schemas.js";
import { connectionRecords, resolveConnectionRecord } from "./connections.js";
import { ContextTreeError } from "./internal/errors.js";
import { type CommandRunner, git, sanitizeCommandOutput } from "./internal/git.js";
import { validateStoredTreeState } from "./internal/tree-state.js";

/**
 * Local trees report their checked-out state without network access. GitHub
 * trees fast-forward the exact checked-out branch once, then revalidate.
 */
export function syncConnection(projectPath: string, runner?: CommandRunner, alias?: string): ContextTreeSyncSnapshot {
  const connection = resolveConnectionRecord(projectPath, runner, alias);
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
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    sha,
    tree: connection.tree,
  };
}

export function syncProject(projectPath: string, runner?: CommandRunner, alias?: string): ContextTreeSyncResult {
  const records = connectionRecords(projectPath, runner, alias);
  if (!records.length)
    throw new ContextTreeError(
      CLI_ERROR_CODES.noConnection,
      "No Context Tree connection exists; run context-tree create or connect.",
    );
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    connections: records.map((connection) => {
      try {
        return { ...syncConnection(projectPath, runner, connection.alias), alias: connection.alias, ok: true as const };
      } catch (error) {
        return {
          alias: connection.alias,
          tree: connection.tree,
          ok: false as const,
          error: {
            code: error instanceof ContextTreeError ? error.code : CLI_ERROR_CODES.failed,
            message: sanitizeCommandOutput(error instanceof Error ? error.message : "Synchronization failed."),
          },
        };
      }
    }),
  };
}
