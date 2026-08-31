import { lstatSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SCHEMA_VERSION, treeNameSchema, type VerifyTreeReport } from "../schemas.js";
import { type CommandRunner, git, gitCommand } from "./internal/git.js";
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
  runner?: CommandRunner | undefined;
};

type ScaffoldTreeResult = {
  branch: string;
  commit: string;
  files: string[];
  root: string;
  schemaVersion: typeof SCHEMA_VERSION;
  verification: VerifyTreeReport;
};

const SCAFFOLD_FILES = ["NODE.md", "AGENTS.md", "CLAUDE.md", ".github/workflows/validate-context-tree.yml"];

function initializeGitRepository(root: string, runner?: CommandRunner): string {
  gitCommand(["init", "--quiet", "--", root], { message: "Failed to initialize Git repository.", runner });
  return git(root, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the initial Git branch during repository initialization.",
    runner,
  });
}

function commitScaffold(root: string, runner?: CommandRunner): string {
  for (const file of SCAFFOLD_FILES) {
    git(root, ["add", "--", file], { message: "Failed to stage the scaffold files.", runner });
  }
  git(
    root,
    [
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
    { message: "Failed to commit the scaffold.", runner },
  );
  return git(root, ["rev-parse", "HEAD"], { message: "Failed to resolve the scaffold commit.", runner });
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
  const initialBranch = initializeGitRepository(root, options.runner);
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
  const commit = commitScaffold(root, options.runner);

  return {
    branch: initialBranch,
    commit,
    files: SCAFFOLD_FILES,
    root,
    schemaVersion: SCHEMA_VERSION,
    verification,
  };
}
