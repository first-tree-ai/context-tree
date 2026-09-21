import { existsSync, lstatSync, mkdirSync, rmSync } from "node:fs";
import { basename, join } from "node:path";

import { type CreateProjectResult, SCHEMA_VERSION, treeNameSchema } from "../schemas.js";
import { connectionRecords, managedTreesRoot, resolveConnectionRecord, upsertConnection } from "./connections.js";
import { type CommandRunner, git } from "./internal/git.js";
import { canonicalProjectRoot } from "./internal/project.js";
import { linkProjectInstructions } from "./internal/project-instructions.js";
import { readRootNode } from "./internal/root-node.js";
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

function existingCreateResult(canonical: string, destination: string, runner?: CommandRunner): CreateProjectResult {
  const branch = git(destination, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the managed tree branch.",
    runner,
  });
  const commitSha = git(destination, ["rev-parse", "HEAD"], {
    message: "Failed to resolve the managed tree commit.",
    runner,
  });
  linkProjectInstructions(canonical);
  return {
    branch,
    commitSha,
    created: false,
    schemaVersion: SCHEMA_VERSION,
    title: readRootNode(destination).frontmatter.title,
    treePath: destination,
  };
}

/** Create and connect the project's uniquely named managed local Context Tree. */
export function createProject(
  projectPath: string,
  runner?: CommandRunner,
  options: { name?: string | undefined; alias?: string | undefined } = {},
): CreateProjectResult {
  const canonical = canonicalProjectRoot(projectPath, runner);
  const name = treeNameSchema.parse(options.name ?? `${projectName(canonical)}-context-tree`);
  const destination = join(managedTreesRoot(), name);
  if (name !== name.toLowerCase()) throw new Error("Managed tree names must be lowercase.");
  const alias = treeNameSchema.parse(options.alias ?? name);
  const current = connectionRecords(canonical, runner).find((c) => c.alias === alias);
  if (current && current.tree.path !== destination)
    throw new Error("Connection alias already belongs to a different tree.");

  if (existsSync(destination)) {
    const entry = lstatSync(destination);
    if (entry.isSymbolicLink() || !entry.isDirectory() || current === undefined) {
      throw new Error(`Managed Context Tree name ${name} is occupied; run context-tree connect ${name}.`);
    }
    resolveConnectionRecord(canonical, runner, alias);
    return existingCreateResult(canonical, destination, runner);
  }

  mkdirSync(destination, { mode: 0o700 });
  try {
    const scaffold = scaffoldTree({ name, path: destination, runner });
    upsertConnection({ alias, projectPath: canonical, tree: { kind: "local", path: scaffold.root } }, runner);
    linkProjectInstructions(canonical);
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
