import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

import { SCHEMA_VERSION, type ScaffoldTreeResult } from "../schemas.js";
import { readPackageManifest, resolvePackagedResource } from "./internal/packaged-resource.js";
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
  title: string;
};

export function scaffoldTree(options: ScaffoldTreeOptions): ScaffoldTreeResult {
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
  const repository = options.repository.trim();
  const title = options.title.trim();
  const unsafeTitle = [...title].some((character) => {
    const code = character.codePointAt(0);
    return code !== undefined && (code <= 0x1f || code === 0x7f);
  });
  if (!title || title.length > 200 || unsafeTitle) {
    throw new Error("Tree title must be a non-empty single line of at most 200 characters.");
  }
  const repositoryParts = repository.split("/");
  const [repositoryOwner, repositoryName] = repositoryParts;
  if (
    options.repository !== repository ||
    repositoryParts.length !== 2 ||
    repositoryOwner === undefined ||
    repositoryName === undefined ||
    !/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u.test(repositoryOwner) ||
    !/^[A-Za-z\d._-]{1,100}$/u.test(repositoryName) ||
    repositoryName === "." ||
    repositoryName === ".." ||
    /\.git$/iu.test(repositoryName)
  ) {
    throw new Error("Repository must be an explicit GitHub OWNER/REPO identity.");
  }
  const manifest = readPackageManifest();
  if (!("version" in manifest) || typeof manifest.version !== "string") {
    throw new Error("Package version is missing or invalid.");
  }
  const values = {
    packageVersion: manifest.version,
    title,
    titleJson: JSON.stringify(title),
  };
  mkdirSync(root, { recursive: true });

  const files: Array<readonly [string, string]> = [
    ["NODE.md", "root-node.md"],
    ["SCOPE.md", "scope.md"],
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
