import { basename, relative, resolve } from "node:path";
import type { CommandRunner } from "../adapters/git.js";
import { sanitizeCommandOutput } from "../adapters/git.js";
import {
  CLI_ERROR_CODES,
  connectionSchema,
  type ResolvedTree,
  SCHEMA_VERSION,
  type SyncResult,
  type TreeSource,
} from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { projectRoot } from "../sources/project.js";
import { resolveSource } from "../sources/resolve.js";
import { isPathInside, toPosixPath } from "../tree/path.js";
import { scaffoldTree } from "../tree/scaffold.js";
import { connect, connections } from "./connections.js";

export function directorySource(project: string, path: string): TreeSource {
  const absolute = resolve(path);
  return {
    kind: "directory",
    path: isPathInside(project, absolute) ? toPosixPath(relative(project, absolute)) || "." : absolute,
  };
}
export function connectTree(project: string, source: TreeSource, runner?: CommandRunner): ResolvedTree {
  const root = projectRoot(project, runner);
  const candidate = connectionSchema.parse({ projectRoot: root, source });
  const resolved = resolveSource(candidate, true, runner);
  return {
    ...resolved,
    connection: connect(
      root,
      candidate.source.kind === "directory" ? directorySource(root, resolved.treeRoot) : candidate.source,
      runner,
    ),
  };
}
export function initTree(project: string, path: string, runner?: CommandRunner): ResolvedTree {
  const root = projectRoot(project, runner);
  const treeRoot = scaffoldTree(path, basename(resolve(path)));
  // Failed attachment leaves the successfully initialized content available to connect explicitly.
  return connectTree(root, directorySource(root, treeRoot), runner);
}
export function syncTrees(project: string, selector?: string, offline = false, runner?: CommandRunner): SyncResult {
  return {
    schemaVersion: SCHEMA_VERSION,
    connections: connections(project, selector, runner).map((entry) => {
      try {
        return { ok: true as const, ...resolveSource(entry, !offline, runner) };
      } catch (error) {
        return {
          ok: false as const,
          connection: entry,
          error: {
            code: error instanceof ContextTreeError ? error.code : CLI_ERROR_CODES.failed,
            message: sanitizeCommandOutput(error instanceof Error ? error.message : "Resolution failed."),
          },
        };
      }
    }),
  };
}
