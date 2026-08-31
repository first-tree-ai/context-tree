import { spawnSync } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";

import {
  type ContextTreeDiffResult,
  type ContextTreeLink,
  type ContextTreeRefreshResult,
  type ContextTreeStageResult,
  SCHEMA_VERSION,
} from "../schemas.js";
import { resolveLink } from "./links.js";

function git(root: string, args: string[]): string {
  const result = spawnSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (result.error !== undefined || result.status !== 0) {
    throw new Error("A Git operation failed while preparing the Context Tree.");
  }
  return typeof result.stdout === "string" ? result.stdout : "";
}

function requireGit(root: string, args: string[], allowEmpty = false): string {
  const output = git(root, args).trim();
  if (output.length === 0 && !allowEmpty) throw new Error("Unexpected empty Git output.");
  return output;
}

function discoverDefaultBranch(root: string): string {
  const output = git(root, ["ls-remote", "--symref", "origin", "HEAD"]);
  const refs = output
    .split("\n")
    .map((line) => /^ref: refs\/heads\/([^\s\t]+)\tHEAD$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined && value.length > 0);
  if (refs.length !== 1) {
    throw new Error("The Context Tree origin must report exactly one live default branch.");
  }
  return refs[0] ?? "";
}

export function refreshProject(projectPath: string): ContextTreeRefreshResult {
  const result = resolveLink(projectPath);
  const root = result.link.tree.path;
  const defaultBranch = discoverDefaultBranch(root);
  const local = requireGit(root, ["symbolic-ref", "--short", "HEAD"]);
  if (local !== defaultBranch) {
    throw new Error(`The Context Tree checkout must be on the live default branch "${defaultBranch}".`);
  }
  const before = requireGit(root, ["rev-parse", "HEAD"]);
  requireGit(root, ["pull", "--ff-only", "origin", defaultBranch]);
  const after = requireGit(root, ["rev-parse", "HEAD"]);
  const link: ContextTreeLink = {
    ...result.link,
    tree: { ...result.link.tree, path: realpathSync(root) },
  };
  return {
    link,
    defaultBranch,
    refreshed: before !== after,
    schemaVersion: SCHEMA_VERSION,
    sha: after,
  };
}

function createIsolatedWorktree(treePath: string, baseSha: string): { taskBranch: string; worktreePath: string } {
  const destination = mkdtempSync(join(tmpdir(), "context-tree-stage-"));
  const taskBranch = `context-tree/write/${basename(destination)}`;
  git(treePath, ["worktree", "add", "-b", taskBranch, destination, baseSha]);
  return { taskBranch, worktreePath: realpathSync(destination) };
}

export function stageContextWrite(projectPath: string): ContextTreeStageResult {
  const result = resolveLink(projectPath);
  const treePath = result.link.tree.path;
  const ownerRepository = result.link.tree.repository;
  const defaultBranch = discoverDefaultBranch(treePath);
  const local = requireGit(treePath, ["symbolic-ref", "--short", "HEAD"]);
  if (local !== defaultBranch) {
    throw new Error(`The Context Tree checkout must be on the live default branch "${defaultBranch}".`);
  }
  requireGit(treePath, ["fetch", "origin", defaultBranch], true);
  const baseSha = requireGit(treePath, ["rev-parse", `origin/${defaultBranch}`]);
  const { taskBranch, worktreePath } = createIsolatedWorktree(treePath, baseSha);
  const link: ContextTreeLink = {
    project: result.link.project,
    tree: { path: treePath, repository: ownerRepository },
  };
  return {
    baseSha,
    link,
    defaultBranch,
    schemaVersion: SCHEMA_VERSION,
    taskBranch,
    worktreePath,
  };
}

const DIFF_STATUS = { A: "added", D: "deleted", M: "modified", R: "renamed" } as const;
type DiffStatus = (typeof DIFF_STATUS)[keyof typeof DIFF_STATUS];

function changedFiles(root: string, base: string): Array<{ path: string; status: DiffStatus }> {
  const output = git(root, ["diff", "--name-status", base]);
  const files: Array<{ path: string; status: DiffStatus }> = [];
  for (const line of output.split("\n")) {
    const match = /^([ADMR])\s+(.+)$/u.exec(line);
    if (match === null) continue;
    const status = DIFF_STATUS[match[1] as "A" | "D" | "M" | "R"];
    if (status === undefined) continue;
    files.push({ path: match[2] ?? "", status });
  }
  // Untracked Markdown files are pending edits the diff against a base cannot
  // see. Report them so a write never publishes content outside the change.
  const porcelain = git(root, ["status", "--porcelain", "--untracked-files=all"]);
  for (const line of porcelain.split("\n")) {
    const path = /^\?\?\s+(.+)$/u.exec(line)?.[1];
    if (path !== undefined && path.length > 0) files.push({ path, status: "added" });
  }
  return files;
}

export function inspectContextTreeDiff(treePath: string, base?: string): ContextTreeDiffResult {
  const root = realpathSync(treePath);
  const reference = base ?? "HEAD";
  return {
    base: reference,
    files: changedFiles(root, reference),
    patch: git(root, ["diff", reference]),
    schemaVersion: SCHEMA_VERSION,
    treePath: root,
  };
}
