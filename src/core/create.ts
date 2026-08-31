import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { type CreateProjectResult, SCHEMA_VERSION, treeNameSchema } from "../schemas.js";
import { findConnectionRecord, managedTreesRoot, resolveConnectionRecord, upsertConnection } from "./connections.js";
import { type CommandRunner, git } from "./internal/git.js";
import { canonicalProjectRoot } from "./internal/project.js";
import { parseRootNode } from "./internal/tree-state.js";
import { scaffoldTree } from "./scaffold.js";

function projectName(canonicalRoot: string): string {
  const normalized = basename(canonicalRoot)
    .toLowerCase()
    .replace(/[^a-z\d._-]+/gu, "-")
    .replace(/-{2,}/gu, "-")
    .replace(/^[-.]+/u, "")
    .replace(/[-.]+$/u, "")
    .slice(0, 40);
  return /^[a-z\d]/u.test(normalized) ? normalized : "project";
}

function existingCreateResult(destination: string, projectPath: string, runner?: CommandRunner): CreateProjectResult {
  const connection = resolveConnectionRecord(projectPath, runner);
  if (connection.tree.path !== destination) {
    throw new Error(
      `Managed Context Tree name is occupied; run context-tree connect ${projectName(projectPath)}-context-tree.`,
    );
  }
  const branch = git(destination, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the managed tree branch.",
    runner,
  });
  const commitSha = git(destination, ["rev-parse", "HEAD"], {
    message: "Failed to resolve the managed tree commit.",
    runner,
  });
  return {
    branch,
    commitSha,
    created: false,
    schemaVersion: SCHEMA_VERSION,
    title: parseRootNode(destination).frontmatter.title,
    treePath: destination,
  };
}

/** Create and connect the project's uniquely named managed local Context Tree. */
export function createProject(projectPath: string, runner?: CommandRunner): CreateProjectResult {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const name = treeNameSchema.parse(`${projectName(canonical)}-context-tree`);
  const destination = join(managedTreesRoot(), name);

  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    const current = findConnectionRecord(canonical, runner);
    if (entry.isSymbolicLink() || !entry.isDirectory() || current?.tree.path !== destination) {
      throw new Error(`Managed Context Tree name ${name} is occupied; run context-tree connect ${name}.`);
    }
    return existingCreateResult(destination, canonical, runner);
  }

  mkdirSync(destination, { mode: 0o700 });
  try {
    const scaffold = scaffoldTree({ name, path: destination, runner });
    upsertConnection({ projectPath: canonical, tree: { kind: "local", path: scaffold.root } }, runner);
    return {
      branch: scaffold.branch,
      commitSha: scaffold.commit,
      created: true,
      schemaVersion: SCHEMA_VERSION,
      title: name,
      treePath: scaffold.root,
    };
  } catch (error) {
    rmSync(destination, { force: true, recursive: true });
    throw error;
  }
}
