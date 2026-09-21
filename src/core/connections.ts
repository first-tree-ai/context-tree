import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";

import type { z } from "zod";
import {
  CLI_ERROR_CODES,
  CONNECTION_SCHEMA_VERSION,
  type ConnectProjectResult,
  type ContextTreeConnection,
  type ContextTreeConnectionResult,
  connectionsFileSchema,
  contextTreeStateSchema,
  type DisconnectProjectResult,
  githubRepositoryIdentitySchema,
  type ManagedTreeListingEntry,
  type ManagedTreeListingResult,
  SCHEMA_VERSION,
  treeNameSchema,
} from "../schemas.js";
import { ContextTreeError } from "./internal/errors.js";
import { CommandError, type CommandRunner, git, optionalGit, sanitizeCommandOutput } from "./internal/git.js";
import { canonicalGitHubRepositoryUrl, gitHubRepositoryFromOriginUrl } from "./internal/github-repository.js";
import { canonicalProjectRoot } from "./internal/project.js";
import { linkProjectInstructions } from "./internal/project-instructions.js";
import { validateStoredTreeState, validateTreeCheckout } from "./internal/tree-state.js";

type ConnectionsFile = z.infer<typeof connectionsFileSchema>;

const DUPLICATE_MESSAGE = "Duplicate Context Tree connection records exist for this project.";
const NO_CONNECTION_MESSAGE = "No Context Tree connection exists for this project; run context-tree create or connect.";

function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

/** Create a managed application directory below the home directory, failing closed on symlinks. */
function ensureManagedDirectory(...segments: string[]): string {
  let current = realHome();
  for (const segment of segments) {
    current = join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Context Tree managed directory must be a real directory: ${current}`);
    }
  }
  return current;
}

/** The managed namespace without creating it; listing must not create an absent directory. */
function managedTreesPath(): string {
  return join(realHome(), ".context-tree", "trees");
}

function connectionsPath(): string {
  return join(realHome(), ".context-tree", "connections.json");
}

export function managedTreesRoot(): string {
  return ensureManagedDirectory(".context-tree", "trees");
}

function loadConnections(required: boolean): ConnectionsFile {
  const path = connectionsPath();
  const parent = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (parent && (parent.isSymbolicLink() || !parent.isDirectory()))
    throw new ContextTreeError(CLI_ERROR_CODES.corruptConnection, "Unsafe connections directory.");
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    if (required) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
    return { connections: [], schemaVersion: CONNECTION_SCHEMA_VERSION };
  }
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("not a regular file");
    return connectionsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new ContextTreeError(
      CLI_ERROR_CODES.corruptConnection,
      "Context Tree connections use an unsupported or corrupt format; the stored file has been preserved.",
    );
  }
}

function saveConnections(value: ConnectionsFile): void {
  const directory = ensureManagedDirectory(".context-tree");
  const path = join(directory, "connections.json");
  const temporary = join(directory, `.connections-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(connectionsFileSchema.parse(value), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  try {
    renameSync(temporary, path);
    chmodSync(path, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}

export function connectionRecords(
  projectPath: string,
  runner?: CommandRunner,
  alias?: string,
): ContextTreeConnection[] {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const matches = loadConnections(false)
    .connections.filter((c) => c.projectPath === canonical)
    .sort((a, b) => a.alias.localeCompare(b.alias));
  if (
    new Set(matches.map((c) => c.alias)).size !== matches.length ||
    new Set(matches.map((c) => treeKey(c.tree))).size !== matches.length ||
    new Set(matches.map((c) => c.tree.path)).size !== matches.length
  )
    throw new ContextTreeError(CLI_ERROR_CODES.corruptConnection, DUPLICATE_MESSAGE);
  if (alias === undefined) return matches;
  const selected = matches.filter((c) => c.alias === alias);
  if (!selected.length)
    throw new ContextTreeError(CLI_ERROR_CODES.noConnection, `No connection named ${alias}. Run context-tree resolve.`);
  return selected;
}
function treeKey(tree: ContextTreeConnection["tree"]): string {
  return tree.kind === "github" ? `github:${tree.repository.toLowerCase()}` : `local:${tree.path}`;
}
function selectConnection(matches: ContextTreeConnection[]): ContextTreeConnection | undefined {
  if (matches.length > 1)
    throw new ContextTreeError(
      CLI_ERROR_CODES.ambiguousConnection,
      "Several Context Trees are connected; select --tree <alias> (see context-tree resolve).",
    );
  return matches[0];
}

function isManagedName(value: string): boolean {
  return treeNameSchema.safeParse(value).success && value === value.toLowerCase();
}

function managedName(value: string): string {
  if (!isManagedName(value)) {
    throw new Error(`Managed Context Tree names must be safe lowercase path segments: ${value}`);
  }
  return value;
}

/** List valid, clean managed trees, excluding unsafe or invalid candidates without failing the listing. */
export function listManagedTrees(runner?: CommandRunner): ManagedTreeListingResult {
  const root = managedTreesPath();
  if (!existsSync(root)) return { schemaVersion: SCHEMA_VERSION, trees: [] };
  const rootEntry = lstatSync(root);
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) {
    throw new Error("Context Tree managed directory must be a real directory.");
  }
  const trees: ManagedTreeListingEntry[] = [];
  for (const candidate of readdirSync(root, { withFileTypes: true })) {
    if (!candidate.isDirectory() || !isManagedName(candidate.name)) continue;
    try {
      trees.push({ name: candidate.name, tree: classifyCheckout(join(root, candidate.name), runner) });
    } catch {
      // An unsafe or invalid candidate is skipped, never a listing failure.
    }
  }
  trees.sort((left, right) => left.name.localeCompare(right.name));
  return { schemaVersion: SCHEMA_VERSION, trees };
}

export function findConnectionRecord(
  projectPath: string,
  runner?: CommandRunner,
  alias?: string,
): ContextTreeConnection | undefined {
  return selectConnection(connectionRecords(projectPath, runner, alias));
}

function validateManagedTreeState(
  tree: ContextTreeConnection["tree"],
  runner?: CommandRunner,
): ContextTreeConnection["tree"] {
  const validated = validateStoredTreeState(tree, runner);
  // Stored validation accepts verified external disk paths in place; the
  // managed-name discipline applies only inside the managed namespace, which
  // is also the only namespace name-based discovery consults.
  if (dirname(validated.path) === managedTreesPath() && !isManagedName(basename(validated.path))) {
    throw new Error(`Managed Context Tree names must be safe lowercase path segments: ${basename(validated.path)}`);
  }
  return validated;
}

export function resolveConnectionRecord(
  projectPath: string,
  runner?: CommandRunner,
  alias?: string,
): ContextTreeConnection {
  const connection = selectConnection(connectionRecords(projectPath, runner, alias));
  if (connection === undefined) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
  try {
    return { ...connection, tree: validateManagedTreeState(connection.tree, runner) };
  } catch (error) {
    // Dirty and invalid checkouts already carry their own specific code.
    if (error instanceof ContextTreeError) throw error;
    const detail = error instanceof Error ? error.message : "unknown failure";
    throw new ContextTreeError(
      CLI_ERROR_CODES.staleConnection,
      `The connected Context Tree is no longer usable at ${connection.tree.path}; remove the stale alias with context-tree disconnect --tree <alias>, then run context-tree connect at its current location. ${detail}`,
    );
  }
}

export function resolveConnection(
  projectPath: string,
  runner?: CommandRunner,
  alias?: string,
): ContextTreeConnectionResult {
  const records = connectionRecords(projectPath, runner, alias);
  if (!records.length) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
  return {
    schemaVersion: CONNECTION_SCHEMA_VERSION,
    connections: records.map((connection) => {
      try {
        return { ...resolveConnectionRecord(projectPath, runner, connection.alias), ok: true as const };
      } catch (error) {
        return {
          ...connection,
          ok: false as const,
          error: {
            code: error instanceof ContextTreeError ? error.code : CLI_ERROR_CODES.failed,
            message: sanitizeCommandOutput(error instanceof Error ? error.message : "Connection unavailable."),
          },
        };
      }
    }),
  };
}

export function upsertConnection(connection: ContextTreeConnection, runner?: CommandRunner): ConnectProjectResult {
  const canonical = canonicalProjectRoot(connection.projectPath, runner);
  const record: ContextTreeConnection = {
    alias: treeNameSchema.parse(connection.alias),
    projectPath: canonical,
    tree: validateManagedTreeState(contextTreeStateSchema.parse(connection.tree), runner),
  };
  const stored = loadConnections(false);
  const matches = connectionRecords(canonical, runner);
  const previous = matches.find((c) => c.alias === record.alias);
  if (previous && treeKey(previous.tree) !== treeKey(record.tree))
    throw new Error("Connection alias already belongs to a different tree.");
  if (
    matches.some(
      (c) => c.alias !== record.alias && (treeKey(c.tree) === treeKey(record.tree) || c.tree.path === record.tree.path),
    )
  )
    throw new Error("This tree is already attached under another alias.");
  if (previous !== undefined && JSON.stringify(previous.tree) === JSON.stringify(record.tree)) {
    return { schemaVersion: CONNECTION_SCHEMA_VERSION, alias: record.alias, tree: record.tree };
  }
  saveConnections({
    connections: [
      ...stored.connections.filter(
        (candidate) => candidate.projectPath !== canonical || candidate.alias !== record.alias,
      ),
      record,
    ],
    schemaVersion: CONNECTION_SCHEMA_VERSION,
  });
  return { schemaVersion: CONNECTION_SCHEMA_VERSION, alias: record.alias, tree: record.tree };
}

export function updateConnectionTree(
  projectPath: string,
  tree: ContextTreeConnection["tree"],
  runner?: CommandRunner,
): void {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const stored = loadConnections(true);
  if (!stored.connections.some((c) => c.projectPath === canonical && c.tree.path === tree.path)) {
    throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
  }
  const validatedTree = validateManagedTreeState(contextTreeStateSchema.parse(tree), runner);
  saveConnections({
    connections: stored.connections.map((connection) =>
      connection.tree.path === tree.path ? { ...connection, tree: validatedTree } : connection,
    ),
    schemaVersion: CONNECTION_SCHEMA_VERSION,
  });
}

/**
 * Validate an exact checkout and classify it from a safe origin: no origin
 * is local state, a credential-free GitHub origin is GitHub state, and any
 * other origin is rejected as unsafe or unsupported.
 */
function classifyCheckout(path: string, runner?: CommandRunner): ContextTreeConnection["tree"] {
  const root = validateTreeCheckout(path, runner);
  const origin = optionalGit(root, ["remote", "get-url", "origin"], runner);
  if (origin === undefined) return { kind: "local", path: root };
  return { kind: "github", path: root, repository: gitHubRepositoryFromOriginUrl(origin) };
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

/** An existing managed directory that must be a real directory, not a symlinked alias. */
function realManagedDirectory(name: string, destination: string): void {
  const entry = lstatSync(destination);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error(`Managed Context Tree name ${name} is occupied by an unsafe destination.`);
  }
}

export type ConnectProjectOptions = (
  | { projectPath: string; target: string }
  | { projectPath: string; treePath: string }
) & { alias?: string | undefined };

/**
 * Connect by exact managed name or GitHub OWNER/REPO, or attach an exact,
 * clean, fully valid Git checkout at an explicit disk path in place.
 */
export function connectProject(options: ConnectProjectOptions, runner?: CommandRunner): ConnectProjectResult {
  /** Store the connection and offer instruction discovery for existing project instructions. */
  const connect = (tree: ContextTreeConnection["tree"]): ConnectProjectResult => {
    const result = upsertConnection(
      {
        alias:
          options.alias ?? ("target" in options ? options.target.split("/").at(-1) : undefined) ?? basename(tree.path),
        projectPath: options.projectPath,
        tree,
      },
      runner,
    );
    const canonical = canonicalProjectRoot(options.projectPath, runner);
    linkProjectInstructions(canonical);
    return {
      schemaVersion: CONNECTION_SCHEMA_VERSION,
      alias: result.alias,
      tree: result.tree,
    };
  };

  if ("treePath" in options) return connect(classifyCheckout(options.treePath, runner));

  const treesRoot = managedTreesRoot();
  if (!options.target.includes("/")) {
    const name = managedName(options.target);
    const destination = join(treesRoot, name);
    if (!existsSync(destination)) throw new Error(`No managed Context Tree named ${name} exists.`);
    realManagedDirectory(name, destination);
    return connect(classifyCheckout(destination, runner));
  }

  const repository = githubRepositoryIdentitySchema.parse(options.target);
  const repositoryName = repository.split("/")[1];
  if (repositoryName === undefined) throw new Error("Repository must be OWNER/REPO.");
  // Reuse published or legacy checkouts only after verifying their full origin identity.
  for (const candidate of listManagedTrees(runner).trees) {
    if (candidate.tree.kind === "github" && sameRepository(candidate.tree.repository, repository))
      return connect(candidate.tree);
  }
  const name = managedName(`github-${createHash("sha256").update(repository.toLowerCase()).digest("hex")}`);
  const destination = join(treesRoot, name);

  if (existsSync(destination)) {
    realManagedDirectory(name, destination);
    const tree = classifyCheckout(destination, runner);
    if (tree.kind !== "github" || !sameRepository(tree.repository, repository)) {
      throw new Error(`Managed Context Tree name ${name} is already used by a different tree.`);
    }
    return connect(tree);
  }

  mkdirSync(destination, { mode: 0o700 });
  try {
    git(
      treesRoot,
      ["clone", "--quiet", "--origin", "origin", "--", canonicalGitHubRepositoryUrl(repository), destination],
      { message: "Cloning the Context Tree repository failed.", runner },
    );
    const tree = classifyCheckout(destination, runner);
    if (tree.kind !== "github" || !sameRepository(tree.repository, repository)) {
      throw new Error("The cloned Context Tree origin does not match the requested repository.");
    }
    return connect(tree);
  } catch (error) {
    rmSync(destination, { force: true, recursive: true });
    if (
      error instanceof CommandError &&
      /gh auth login|not logged|authentication failed|http 401|bad credentials|could not read Username|terminal prompts disabled/iu.test(
        error.stderr,
      )
    ) {
      throw new ContextTreeError(
        CLI_ERROR_CODES.githubAuth,
        "GitHub authentication failed; run gh auth login before connecting.",
      );
    }
    if (error instanceof CommandError && /http 403|permission denied|not authorized/iu.test(error.stderr)) {
      throw new ContextTreeError(CLI_ERROR_CODES.githubPermission, "GitHub denied access to this repository.");
    }
    throw error;
  }
}

/** Remove only the project record, even if its tree is no longer usable. */
export function disconnectProject(
  projectPath: string,
  runner?: CommandRunner,
  options: { tree?: string | undefined; all?: boolean } = {},
): DisconnectProjectResult {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const stored = loadConnections(false);
  if (options.all && options.tree) throw new Error("Choose --all or --tree, not both.");
  const selected = options.all ? undefined : selectConnection(connectionRecords(projectPath, runner, options.tree));
  const remaining = stored.connections.filter(
    (connection) => connection.projectPath !== canonical || (!options.all && connection.alias !== selected?.alias),
  );
  if (remaining.length !== stored.connections.length) saveConnections({ ...stored, connections: remaining });
  return { schemaVersion: SCHEMA_VERSION, disconnected: remaining.length !== stored.connections.length };
}
