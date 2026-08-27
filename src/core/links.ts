import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { z } from "zod";
import {
  CLI_ERROR_CODES,
  type ContextTreeLink,
  type ContextTreeLinkResult,
  type ContextTreeProjectIdentity,
  contextTreeLinkSchema,
  credentialFreeRepositoryUrlSchema,
  parseContextTreeRootNode,
  SCHEMA_VERSION,
} from "../schemas.js";
import { readUtf8File } from "./internal/filesystem.js";
import { canonicalGitHubRepositoryUrl, repositoryIdentityFromGitHubUrl } from "./internal/github-repository.js";
import { isPathInside } from "./path.js";
import { verifyTree } from "./verify.js";

const contextTreeLinksFileSchema = z
  .object({ links: z.array(contextTreeLinkSchema), schemaVersion: z.literal(SCHEMA_VERSION) })
  .strict();
type ContextTreeLinksFile = z.infer<typeof contextTreeLinksFileSchema>;

type Checkout = { path: string; repository: string };
type CheckoutMode = "link" | "scaffold";

export class LinkError extends Error {
  public readonly code: (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES];

  public constructor(code: (typeof CLI_ERROR_CODES)[keyof typeof CLI_ERROR_CODES], message: string) {
    super(message);
    this.name = "LinkError";
    this.code = code;
  }
}

function git(path: string, args: string[]): string | undefined {
  const result = spawnSync("git", ["-C", path, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error !== undefined || result.status !== 0) return undefined;
  return result.stdout.replace(/\r?\n$/u, "");
}

function requireGit(path: string, args: string[], message: string, allowEmpty = false): string {
  const value = git(path, args);
  if (value === undefined || (!allowEmpty && value.length === 0)) throw new Error(message);
  return value;
}

export function normalizeRepositoryUrl(repositoryUrl: string): string {
  try {
    credentialFreeRepositoryUrlSchema.parse(repositoryUrl);
  } catch {
    throw new Error("Git origin must be a canonical credential-free repository URL.");
  }
  try {
    const identity = repositoryIdentityFromGitHubUrl(repositoryUrl);
    return canonicalGitHubRepositoryUrl(identity.toLowerCase());
  } catch {
    // Credential-free non-GitHub project origins remain supported.
  }
  const scp = /^(?:([^@]+)@)?([^:]+):(.+)$/u.exec(repositoryUrl);
  if (scp !== null && !repositoryUrl.includes("://")) {
    const user = scp[1] === undefined ? "" : `${scp[1].toLowerCase()}@`;
    const host = (scp[2] ?? "").toLowerCase();
    const path = (scp[3] ?? "").replace(/\/+$/gu, "").replace(/\.git$/iu, "");
    return `${user}${host}:${path}.git`;
  }
  const parsed = new URL(repositoryUrl);
  parsed.hostname = parsed.hostname.toLowerCase();
  parsed.pathname = `${parsed.pathname.replace(/\/+$/gu, "").replace(/\.git$/iu, "")}.git`;
  return parsed.toString();
}

function realDirectory(path: string): string {
  const absolute = resolve(path);
  const entry = lstatSync(absolute);
  if (!entry.isDirectory()) throw new Error("Project path must be a directory.");
  return realpathSync(absolute);
}

export function identifyProject(projectPath: string): ContextTreeProjectIdentity {
  const path = realDirectory(projectPath);
  const gitRoot = git(path, ["rev-parse", "--show-toplevel"]);
  if (gitRoot === undefined) return { kind: "directory", path };
  const root = realpathSync(gitRoot);
  const origin = requireGit(root, ["remote", "get-url", "origin"], "Git project must have an origin remote.");
  return { kind: "git", origin: normalizeRepositoryUrl(origin) };
}

function linksPath(): string {
  return join(homedir(), ".context-tree", "connections.json");
}

function emptyLinks(): ContextTreeLinksFile {
  return { links: [], schemaVersion: SCHEMA_VERSION };
}

function loadLinks(required: boolean): ContextTreeLinksFile {
  const path = linksPath();
  if (!existsSync(path)) {
    if (required) {
      throw new LinkError(CLI_ERROR_CODES.noLink, "No Context Tree link exists for this project.");
    }
    return emptyLinks();
  }
  try {
    const entry = lstatSync(path);
    if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("not a regular file");
    return contextTreeLinksFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new LinkError(
      CLI_ERROR_CODES.corruptLink,
      "Context Tree links are corrupt; run link after repairing or removing the internal links file.",
    );
  }
}

function saveLinks(value: ContextTreeLinksFile): void {
  const path = linksPath();
  const directory = dirname(path);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const directoryEntry = lstatSync(directory);
  if (directoryEntry.isSymbolicLink() || !directoryEntry.isDirectory()) {
    throw new Error("Context Tree links directory must be a real directory.");
  }
  const temporary = join(directory, `.links-${process.pid}-${Date.now()}.tmp`);
  writeFileSync(temporary, `${JSON.stringify(contextTreeLinksFileSchema.parse(value), null, 2)}\n`, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  renameSync(temporary, path);
  chmodSync(path, 0o600);
}

function exactCheckoutRoot(treePath: string): string {
  const absolute = resolve(treePath);
  const entry = lstatSync(absolute);
  const root = realpathSync(absolute);
  if (!entry.isDirectory() || entry.isSymbolicLink() || absolute !== root) {
    throw new Error("Context Tree checkout path must be a real directory with no symlink component.");
  }
  const gitRoot = requireGit(root, ["rev-parse", "--show-toplevel"], "Context Tree checkout must be a Git repository.");
  if (realpathSync(gitRoot) !== root) throw new Error("Context Tree checkout must be the real Git root.");
  return root;
}

function checkoutRepository(root: string): string {
  const origin = requireGit(root, ["remote", "get-url", "origin"], "Context Tree checkout must have an origin remote.");
  return repositoryIdentityFromGitHubUrl(origin);
}

function requireCheckoutClean(root: string, mode: CheckoutMode): void {
  const status = requireGit(
    root,
    ["status", "--porcelain", "--untracked-files=all"],
    "Failed to inspect Context Tree cleanliness.",
    true,
  );
  if (status.length === 0) return;
  if (mode === "scaffold") {
    const lines = status.split("\n").sort();
    const expected = ["?? .github/workflows/validate-context-tree.yml", "?? NODE.md"];
    if (
      git(root, ["rev-parse", "--verify", "HEAD"]) === undefined &&
      JSON.stringify(lines) === JSON.stringify(expected)
    ) {
      return;
    }
  }
  throw new Error("Context Tree checkout must be clean.");
}

function parseRootNode(root: string): ReturnType<typeof parseContextTreeRootNode> {
  const path = join(root, "NODE.md");
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) throw new Error("Context Tree root NODE.md must be a regular file.");
  return parseContextTreeRootNode(readUtf8File(path));
}

function verifyCheckout(treePath: string, mode: CheckoutMode): Checkout {
  const root = exactCheckoutRoot(treePath);
  requireCheckoutClean(root, mode);
  const repository = checkoutRepository(root);
  const verification = verifyTree(root);
  if (!verification.ok) throw new Error("Context Tree checkout is invalid; run context-tree verify.");
  return { path: root, repository };
}

function sameProject(left: ContextTreeProjectIdentity, right: ContextTreeProjectIdentity): boolean {
  return left.kind === "git" && right.kind === "git"
    ? left.origin === right.origin
    : left.kind === "directory" && right.kind === "directory" && left.path === right.path;
}

function projectMatches(candidate: ContextTreeProjectIdentity, current: ContextTreeProjectIdentity): boolean {
  if (candidate.kind === "git" && current.kind === "git") return candidate.origin === current.origin;
  if (candidate.kind === "directory" && current.kind === "directory") return isPathInside(candidate.path, current.path);
  return false;
}

function liveStoredCheckout(link: ContextTreeLink): Checkout | undefined {
  try {
    const path = exactCheckoutRoot(link.tree.path);
    return { path, repository: checkoutRepository(path) };
  } catch {
    return undefined;
  }
}

function linkWithMode(projectPath: string, treePath: string, mode: CheckoutMode): ContextTreeLinkResult {
  const project = identifyProject(projectPath);
  const tree = verifyCheckout(treePath, mode);
  const stored = loadLinks(false);
  const existing = stored.links.filter((link) => sameProject(link.project, project));
  if (existing.length > 1) {
    throw new LinkError(CLI_ERROR_CODES.ambiguousLink, "Multiple Context Tree links match this project.");
  }
  const previous = existing[0];
  if (previous !== undefined) {
    if (previous.tree.repository.toLowerCase() !== tree.repository.toLowerCase()) {
      throw new Error("A project cannot link to a different Context Tree repository.");
    }
    if (previous.tree.path !== tree.path) {
      const live = liveStoredCheckout(previous);
      if (live !== undefined && live.repository.toLowerCase() === previous.tree.repository.toLowerCase()) {
        throw new Error(
          "The existing Context Tree checkout is still live; replacement is allowed only when it is stale.",
        );
      }
    }
  }
  const link: ContextTreeLink = { project, tree };
  saveLinks({
    links: [...stored.links.filter((candidate) => !sameProject(candidate.project, project)), link],
    schemaVersion: SCHEMA_VERSION,
  });
  return { link, schemaVersion: SCHEMA_VERSION };
}

export function linkProject(projectPath: string, treePath: string): ContextTreeLinkResult {
  return linkWithMode(projectPath, treePath, "link");
}

export function linkScaffoldedProject(projectPath: string, treePath: string): ContextTreeLinkResult {
  return linkWithMode(projectPath, treePath, "scaffold");
}

export function resolveLink(projectPath: string): ContextTreeLinkResult {
  const project = identifyProject(projectPath);
  const stored = loadLinks(true);
  const matches = stored.links.filter((link) => projectMatches(link.project, project));
  if (matches.length === 0) {
    throw new LinkError(CLI_ERROR_CODES.noLink, "No Context Tree link exists for this project.");
  }
  if (matches.length > 1) {
    throw new LinkError(CLI_ERROR_CODES.ambiguousLink, "Multiple Context Tree links match this project.");
  }
  const link = matches[0];
  if (link === undefined) throw new Error("Link lookup failed.");
  try {
    const root = exactCheckoutRoot(link.tree.path);
    requireCheckoutClean(root, "link");
    const repository = checkoutRepository(root);
    if (repository.toLowerCase() !== link.tree.repository.toLowerCase()) {
      throw new Error("The linked path now contains a different Context Tree repository.");
    }
    parseRootNode(root);
    const live: ContextTreeLink = { project: link.project, tree: { path: root, repository } };
    return { link: live, schemaVersion: SCHEMA_VERSION };
  } catch (error) {
    const message =
      error instanceof Error && error.message === "The linked path now contains a different Context Tree repository."
        ? error.message
        : "The linked Context Tree checkout is no longer a valid clean candidate; run link when its stored path is stale.";
    throw new LinkError(CLI_ERROR_CODES.staleLink, message);
  }
}
