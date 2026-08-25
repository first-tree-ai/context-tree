import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SCHEMA_VERSION, type ScaffoldTreeResult } from "../schemas.js";
import { parseGitHubRepositoryIdentity } from "./internal/github-repository.js";
import { readPackageVersion, resolvePackagedResource } from "./internal/packaged-resource.js";
import { verifyTree } from "./verify.js";

function template(name: string, values: Record<string, string>): string {
  let result = readFileSync(resolvePackagedResource("templates", name), "utf8");
  for (const [key, value] of Object.entries(values)) {
    result = result.replaceAll(`{{${key}}}`, value);
  }
  return result;
}

export type ScaffoldTreeOptions = {
  path: string;
  repository: string;
};

function initializeGitRepository(root: string): string {
  const initialized = spawnSync("git", ["init", "--quiet", root], { stdio: "ignore" });
  if (initialized.error !== undefined || initialized.status !== 0) {
    throw new Error("Failed to initialize Git repository.");
  }

  const branch = spawnSync("git", ["-C", root, "symbolic-ref", "--short", "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const name = branch.stdout.replace(/\r?\n$/u, "");
  if (branch.error !== undefined || branch.status !== 0 || name.length === 0) {
    throw new Error("Failed to resolve the initial Git branch during repository initialization.");
  }
  return name;
}

export function scaffoldTree(options: ScaffoldTreeOptions): ScaffoldTreeResult {
  const title = parseGitHubRepositoryIdentity(options.repository);
  const root = resolve(options.path);
  const destination = lstatSync(root, { throwIfNoEntry: false });
  if (destination !== undefined) {
    if (destination.isSymbolicLink() || !destination.isDirectory()) {
      throw new Error(`Refusing to scaffold into a symlink or non-directory destination: ${root}`);
    }
    if (readdirSync(root).length > 0) {
      throw new Error(`Refusing to scaffold into a non-empty directory: ${root}`);
    }
  }
  const initialBranch = initializeGitRepository(root);
  const values = {
    branchJson: JSON.stringify(initialBranch),
    packageVersion: readPackageVersion(),
    title,
    titleJson: JSON.stringify(title),
  };
  const files: Array<readonly [string, string]> = [
    ["NODE.md", "root-node.md"],
    [".github/workflows/validate-context-tree.yml", "validate-context-tree.yml"],
  ];

  for (const [relativePath, source] of files) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template(source, values), { encoding: "utf8", flag: "wx", mode: 0o644 });
  }

  return {
    files: files.map(([path]) => path),
    root,
    schemaVersion: SCHEMA_VERSION,
    verification: verifyTree(root),
  };
}
