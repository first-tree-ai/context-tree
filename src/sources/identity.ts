import { createHash } from "node:crypto";
import { basename, resolve } from "node:path";
import { CLI_ERROR_CODES, type Connection, type TreeSource } from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";

export function sourceIdentity(projectRoot: string, source: TreeSource): string {
  return source.kind === "git"
    ? JSON.stringify(["git", source.repository.toLowerCase(), source.path, source.ref])
    : JSON.stringify(["directory", resolve(projectRoot, source.path)]);
}
export function connectionIdentity(connection: Connection): string {
  return sourceIdentity(connection.projectRoot, connection.source);
}
export function identityId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}

/** Names are shorthand; exact selectors are derived from the complete source. */
export function sourceName(projectRoot: string, source: TreeSource): string {
  return basename(source.kind === "directory" ? resolve(projectRoot, source.path) : source.repository);
}
export function sourceSelector(projectRoot: string, source: TreeSource): string {
  if (source.kind === "directory") return resolve(projectRoot, source.path);
  const path = source.path === "." ? "" : `/${source.path.split("/").map(encodeURIComponent).join("/")}`;
  return `https://github.com/${source.repository}/tree/${encodeURIComponent(source.ref)}${path}`;
}
export function selectSource<T extends { source: TreeSource }>(
  projectRoot: string,
  entries: T[],
  selector?: string,
): T | undefined {
  const matches =
    selector === undefined
      ? entries
      : entries.filter(
          ({ source }) =>
            selector === sourceName(projectRoot, source) || selector === sourceSelector(projectRoot, source),
        );
  if (matches.length > 1)
    throw new ContextTreeError(
      CLI_ERROR_CODES.ambiguousConnection,
      `Select --tree with an exact source: ${matches.map(({ source }) => JSON.stringify(sourceSelector(projectRoot, source))).join(", ")}`,
    );
  return matches[0];
}
