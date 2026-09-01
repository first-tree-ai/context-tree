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

import { z } from "zod";
import {
  CLI_ERROR_CODES,
  type ConnectProjectResult,
  type ContextTreeConnection,
  type ContextTreeConnectionResult,
  contextTreeConnectionSchema,
  contextTreeStateSchema,
  githubRepositoryIdentitySchema,
  type ManagedTreeListingEntry,
  type ManagedTreeListingResult,
  SCHEMA_VERSION,
  treeNameSchema,
} from "../schemas.js";
import { ContextTreeError } from "./internal/errors.js";
import { type CommandRunner, git, optionalGit } from "./internal/git.js";
import { canonicalGitHubRepositoryUrl, gitHubRepositoryFromOriginUrl } from "./internal/github-repository.js";
import { canonicalProjectRoot } from "./internal/project.js";
import { writeProjectPointer } from "./internal/project-pointer.js";
import { validateStoredTreeState, validateTreeCheckout } from "./internal/tree-state.js";

const connectionsFileSchema = z
  .object({ connections: z.array(contextTreeConnectionSchema), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();
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
  if (!existsSync(path)) {
    if (required) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
    return { connections: [], schemaVersion: SCHEMA_VERSION };
  }
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("not a regular file");
    return connectionsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new ContextTreeError(
      CLI_ERROR_CODES.corruptConnection,
      "Context Tree connections are corrupt; remove connections.json and run context-tree connect again.",
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

/** Exactly one record may exist per project; more than one is corruption. */
function singleConnection(stored: ConnectionsFile, canonical: string): ContextTreeConnection | undefined {
  const matches = stored.connections.filter((connection) => connection.projectPath === canonical);
  if (matches.length > 1) throw new ContextTreeError(CLI_ERROR_CODES.corruptConnection, DUPLICATE_MESSAGE);
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

export function findConnectionRecord(projectPath: string, runner?: CommandRunner): ContextTreeConnection | undefined {
  return singleConnection(loadConnections(false), canonicalProjectRoot(projectPath, runner));
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

export function resolveConnectionRecord(projectPath: string, runner?: CommandRunner): ContextTreeConnection {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const connection = singleConnection(loadConnections(true), canonical);
  if (connection === undefined) throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
  try {
    return { projectPath: connection.projectPath, tree: validateManagedTreeState(connection.tree, runner) };
  } catch (error) {
    // Dirty and invalid checkouts already carry their own specific code.
    if (error instanceof ContextTreeError) throw error;
    const detail = error instanceof Error ? error.message : "unknown failure";
    throw new ContextTreeError(
      CLI_ERROR_CODES.staleConnection,
      `The connected Context Tree is no longer usable at ${connection.tree.path}; run context-tree connect to point this project at its current location. ${detail}`,
    );
  }
}

export function resolveConnection(projectPath: string, runner?: CommandRunner): ContextTreeConnectionResult {
  return { schemaVersion: SCHEMA_VERSION, tree: resolveConnectionRecord(projectPath, runner).tree };
}

export function upsertConnection(
  connection: ContextTreeConnection,
  runner?: CommandRunner,
): ContextTreeConnectionResult {
  const canonical = canonicalProjectRoot(connection.projectPath, runner);
  const record: ContextTreeConnection = {
    projectPath: canonical,
    tree: validateManagedTreeState(contextTreeStateSchema.parse(connection.tree), runner),
  };
  const stored = loadConnections(false);
  const previous = singleConnection(stored, canonical);
  if (previous !== undefined && JSON.stringify(previous.tree) === JSON.stringify(record.tree)) {
    return { schemaVersion: SCHEMA_VERSION, tree: record.tree };
  }
  saveConnections({
    connections: [...stored.connections.filter((candidate) => candidate.projectPath !== canonical), record],
    schemaVersion: SCHEMA_VERSION,
  });
  return { schemaVersion: SCHEMA_VERSION, tree: record.tree };
}

export function updateConnectionTree(
  projectPath: string,
  tree: ContextTreeConnection["tree"],
  runner?: CommandRunner,
): void {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const stored = loadConnections(true);
  if (singleConnection(stored, canonical) === undefined) {
    throw new ContextTreeError(CLI_ERROR_CODES.noConnection, NO_CONNECTION_MESSAGE);
  }
  const validatedTree = validateManagedTreeState(contextTreeStateSchema.parse(tree), runner);
  saveConnections({
    connections: stored.connections.map((connection) =>
      connection.projectPath === canonical ? { ...connection, tree: validatedTree } : connection,
    ),
    schemaVersion: SCHEMA_VERSION,
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

export type ConnectProjectOptions = { projectPath: string; target: string } | { projectPath: string; treePath: string };

/**
 * Connect by exact managed name or GitHub OWNER/REPO, or attach an exact,
 * clean, fully valid Git checkout at an explicit disk path in place.
 */
export function connectProject(options: ConnectProjectOptions, runner?: CommandRunner): ConnectProjectResult {
  /** Store the connection, then record it in the project so any agent can find it. */
  const connect = (tree: ContextTreeConnection["tree"]): ConnectProjectResult => {
    const result = upsertConnection({ projectPath: options.projectPath, tree }, runner);
    const canonical = canonicalProjectRoot(options.projectPath, runner);
    return {
      pointer: writeProjectPointer(canonical, result.tree.path),
      schemaVersion: SCHEMA_VERSION,
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
  const name = managedName(repositoryName.toLowerCase());
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
    throw error;
  }
}
