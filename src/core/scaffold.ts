import { spawnSync } from "node:child_process";
import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SCHEMA_VERSION, type ScaffoldTreeResult, treeNameSchema } from "../schemas.js";
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
  name: string;
  path: string;
};

const SCAFFOLD_FILES = ["NODE.md", "AGENTS.md", "CLAUDE.md", ".github/workflows/validate-context-tree.yml"];

function git(root: string, args: string[], message: string): string {
  const result = spawnSync("git", ["-C", root, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  if (result.error !== undefined || result.status !== 0) throw new Error(message);
  return result.stdout.replace(/\r?\n$/u, "");
}

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

function commitScaffold(root: string): string {
  for (const file of SCAFFOLD_FILES) {
    const added = spawnSync("git", ["-C", root, "add", file], { stdio: "ignore" });
    if (added.error !== undefined || added.status !== 0) throw new Error("Failed to stage the scaffold files.");
  }
  const committed = spawnSync(
    "git",
    [
      "-C",
      root,
      "-c",
      "user.name=Context Tree",
      "-c",
      "user.email=context-tree@localhost",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "--quiet",
      "-m",
      "Initialize Context Tree",
    ],
    { stdio: "ignore" },
  );
  if (committed.error !== undefined || committed.status !== 0) throw new Error("Failed to commit the scaffold.");
  return git(root, ["rev-parse", "HEAD"], "Failed to resolve the scaffold commit.");
}

export function scaffoldTree(options: ScaffoldTreeOptions): ScaffoldTreeResult {
  const name = treeNameSchema.parse(options.name);
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
    title: name,
    titleJson: JSON.stringify(name),
  };
  const regularFiles: Array<readonly [string, string]> = [
    ["NODE.md", "root-node.md"],
    ["AGENTS.md", "AGENTS.md"],
    [".github/workflows/validate-context-tree.yml", "validate-context-tree.yml"],
  ];

  for (const [relativePath, source] of regularFiles.slice(0, 2)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template(source, values), { encoding: "utf8", flag: "wx", mode: 0o644 });
  }
  symlinkSync("AGENTS.md", join(root, "CLAUDE.md"), "file");
  for (const [relativePath, source] of regularFiles.slice(2)) {
    const path = join(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, template(source, values), { encoding: "utf8", flag: "wx", mode: 0o644 });
  }

  const verification = verifyTree(root);
  if (!verification.ok) throw new Error("Refusing to commit an invalid Context Tree scaffold.");
  const commit = commitScaffold(root);

  return {
    branch: initialBranch,
    commit,
    files: SCAFFOLD_FILES,
    root,
    schemaVersion: SCHEMA_VERSION,
    verification,
  };
}
