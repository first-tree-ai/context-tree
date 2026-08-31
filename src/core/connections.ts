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
  credentialFreeRepositoryUrlSchema,
  githubRepositoryIdentitySchema,
  type ManagedTreeListingEntry,
  type ManagedTreeListingResult,
  SCHEMA_VERSION,
  treeNameSchema,
} from "../schemas.js";
import { type CommandRunner, git, optionalGit } from "./internal/git.js";
import { canonicalGitHubRepositoryUrl } from "./internal/github-repository.js";
import { canonicalProjectRoot } from "./internal/project.js";
import { validateStoredTreeState, validateTreeCheckout } from "./internal/tree-state.js";

const connectionsFileSchema = z
  .object({ connections: z.array(contextTreeConnectionSchema), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();
type ConnectionsFile = z.infer<typeof connectionsFileSchema>;

export class ConnectionError extends Error {
  public readonly code: (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

  public constructor(code: (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES], message: string) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
  }
}

function connectionsPath(): string {
  return join(homedir(), ".context-tree", "connections.json");
}

function loadConnections(required: boolean): ConnectionsFile {
  const path = connectionsPath();
  if (!existsSync(path)) {
    if (required) {
      throw new ConnectionError(
        CLI_ERROR_CODES.noConnection,
        "No Context Tree connection exists for this project; run context-tree create or connect.",
      );
    }
    return { connections: [], schemaVersion: SCHEMA_VERSION };
  }
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("not a regular file");
    return connectionsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new ConnectionError(
      CLI_ERROR_CODES.corruptConnection,
      "Context Tree connections are corrupt or use the retired links format; remove connections.json and run context-tree connect again.",
    );
  }
}

function saveConnections(value: ConnectionsFile): void {
  const path = connectionsPath();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryEntry = lstatSync(directory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error("Context Tree connections directory must be a real directory.");
  }
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

function realpathHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

/** Create a managed application directory below the home directory, failing closed on symlinks. */
function ensureManagedDirectory(...segments: string[]): string {
  let current = realpathHome();
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

export function managedTreesRoot(): string {
  return ensureManagedDirectory(".context-tree", "trees");
}

/** The managed tree namespace without creating it; listing must not create an absent directory. */
function managedTreesPath(): string {
  return join(realpathHome(), ".context-tree", "trees");
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
    if (!candidate.isDirectory()) continue;
    let name: string;
    let tree: ContextTreeConnection["tree"];
    try {
      name = managedName(candidate.name);
      tree = classifyCheckout(join(root, candidate.name), runner);
    } catch {
      continue;
    }
    trees.push({ name, tree });
  }
  trees.sort((left, right) => left.name.localeCompare(right.name));
  return { schemaVersion: SCHEMA_VERSION, trees };
}

function matchingConnections(stored: ConnectionsFile, canonical: string): ContextTreeConnection[] {
  return stored.connections.filter((connection) => connection.projectPath === canonical);
}

export function findConnectionRecord(projectPath: string, runner?: CommandRunner): ContextTreeConnection | undefined {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const matches = matchingConnections(loadConnections(false), canonical);
  if (matches.length > 1) {
    throw new ConnectionError(
      CLI_ERROR_CODES.corruptConnection,
      "Duplicate Context Tree connection records exist for this project.",
    );
  }
  return matches[0];
}

function validateConnectionTree(
  connection: ContextTreeConnection,
  runner?: CommandRunner,
): ContextTreeConnection["tree"] {
  try {
    return validateManagedTreeState(connection.tree, runner);
  } catch (error) {
    const detail = error instanceof Error ? error.message : "unknown failure";
    throw new ConnectionError(
      CLI_ERROR_CODES.staleConnection,
      `The connected Context Tree checkout is no longer a valid clean candidate; run connect when its stored path is stale. ${detail}`,
    );
  }
}

function validateManagedTreeState(
  tree: ContextTreeConnection["tree"],
  runner?: CommandRunner,
): ContextTreeConnection["tree"] {
  const validated = validateStoredTreeState(tree, runner);
  // Stored validation accepts verified external disk paths in place; the
  // managed-name discipline applies only inside the managed namespace, which
  // is also the only namespace name-based discovery consults.
  if (dirname(validated.path) === managedTreesPath()) {
    managedName(basename(validated.path));
  }
  return validated;
}

export function resolveConnectionRecord(projectPath: string, runner?: CommandRunner): ContextTreeConnection {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const stored = loadConnections(true);
  const matches = matchingConnections(stored, canonical);
  if (matches.length === 0) {
    throw new ConnectionError(
      CLI_ERROR_CODES.noConnection,
      "No Context Tree connection exists for this project; run context-tree create or connect.",
    );
  }
  if (matches.length > 1) {
    throw new ConnectionError(
      CLI_ERROR_CODES.corruptConnection,
      "Duplicate Context Tree connection records exist for this project.",
    );
  }
  const connection = matches[0];
  if (connection === undefined) throw new Error("Connection lookup failed.");
  return { projectPath: connection.projectPath, tree: validateConnectionTree(connection, runner) };
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
  const existing = matchingConnections(stored, canonical);
  if (existing.length > 1) {
    throw new ConnectionError(
      CLI_ERROR_CODES.corruptConnection,
      "Duplicate Context Tree connection records exist for this project.",
    );
  }
  const previous = existing[0];
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
  const matches = matchingConnections(stored, canonical);
  if (matches.length > 1) {
    throw new ConnectionError(
      CLI_ERROR_CODES.corruptConnection,
      "Duplicate Context Tree connection records exist for this project.",
    );
  }
  if (matches.length !== 1) {
    throw new ConnectionError(
      CLI_ERROR_CODES.noConnection,
      "No single Context Tree connection exists for this project.",
    );
  }
  const validatedTree = validateManagedTreeState(contextTreeStateSchema.parse(tree), runner);
  saveConnections({
    connections: stored.connections.map((connection) =>
      connection.projectPath === canonical ? { ...connection, tree: validatedTree } : connection,
    ),
    schemaVersion: SCHEMA_VERSION,
  });
}

function githubRepositoryFromOrigin(origin: string): string {
  try {
    credentialFreeRepositoryUrlSchema.parse(origin);
  } catch {
    throw new Error("Context Tree origin must identify a credential-free GitHub repository.");
  }
  let owner: string | undefined;
  let name: string | undefined;
  const scp = /^(?:git@)?github\.com:([^/]+)\/(.+)$/iu.exec(origin);
  if (scp !== null) {
    [, owner, name] = scp;
  } else {
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      throw new Error("Context Tree origin must identify a credential-free GitHub repository.");
    }
    if (parsed.hostname.toLowerCase() !== "github.com") {
      throw new Error("Context Tree origin must identify a credential-free GitHub repository.");
    }
    [owner, name] = parsed.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  }
  const repository = `${owner ?? ""}/${(name ?? "").replace(/\.git$/iu, "")}`;
  try {
    return githubRepositoryIdentitySchema.parse(repository);
  } catch {
    throw new Error("Context Tree origin must identify a credential-free GitHub OWNER/REPO repository.");
  }
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
  return { kind: "github", path: root, repository: githubRepositoryFromOrigin(origin) };
}

function managedName(value: string): string {
  treeNameSchema.parse(value);
  if (value !== value.toLowerCase()) throw new Error("Managed Context Tree names must be lowercase.");
  return value;
}

function sameRepository(left: string, right: string): boolean {
  return left.toLowerCase() === right.toLowerCase();
}

export type ConnectProjectOptions = { projectPath: string; target: string } | { projectPath: string; treePath: string };

/**
 * Connect by exact managed name or GitHub OWNER/REPO, or attach an exact,
 * clean, fully valid Git checkout at an explicit disk path in place.
 */
export function connectProject(options: ConnectProjectOptions, runner?: CommandRunner): ConnectProjectResult {
  if ("treePath" in options) {
    const tree = classifyCheckout(options.treePath, runner);
    return upsertConnection({ projectPath: options.projectPath, tree }, runner);
  }

  const treesRoot = managedTreesRoot();
  if (!options.target.includes("/")) {
    const name = managedName(options.target);
    const destination = join(treesRoot, name);
    if (!existsSync(destination)) throw new Error(`No managed Context Tree named ${name} exists.`);
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Managed Context Tree name ${name} is occupied by an unsafe destination.`);
    }
    const tree = classifyCheckout(destination, runner);
    return upsertConnection({ projectPath: options.projectPath, tree }, runner);
  }

  const repository = githubRepositoryIdentitySchema.parse(options.target);
  const parts = repository.split("/");
  const repositoryName = parts[1];
  if (repositoryName === undefined) throw new Error("Repository must be OWNER/REPO.");
  const name = managedName(repositoryName.toLowerCase());
  const destination = join(treesRoot, name);
  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Managed Context Tree name ${name} is occupied by an unsafe destination.`);
    }
    const tree = classifyCheckout(destination, runner);
    if (tree.kind !== "github" || !sameRepository(tree.repository, repository)) {
      throw new Error(`Managed Context Tree name ${name} is already used by a different tree.`);
    }
    return upsertConnection({ projectPath: options.projectPath, tree }, runner);
  }

  mkdirSync(destination, { mode: 0o700 });
  try {
    git(
      treesRoot,
      ["clone", "--quiet", "--origin", "origin", "--", canonicalGitHubRepositoryUrl(repository), destination],
      {
        message: "Cloning the Context Tree repository failed.",
        runner,
      },
    );
    const tree = classifyCheckout(destination, runner);
    if (tree.kind !== "github" || !sameRepository(tree.repository, repository)) {
      throw new Error("The cloned Context Tree origin does not match the requested repository.");
    }
    return upsertConnection({ projectPath: options.projectPath, tree }, runner);
  } catch (error) {
    rmSync(destination, { force: true, recursive: true });
    throw error;
  }
}
