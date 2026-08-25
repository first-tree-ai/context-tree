import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import {
  type ContextTreeReadChild,
  type ContextTreeReadNode,
  type ContextTreeReadResult,
  SCHEMA_VERSION,
} from "../schemas.js";
import { classifyContextContent } from "./internal/content-class.js";
import { readNodeDocument } from "./internal/context-document.js";
import { isPathInside, resolveTreeRoot, toPosixPath } from "./path.js";

function normalizeTreeTarget(value: string | undefined): string {
  if (!value || value === ".") return "";
  const normalized = posix.normalize(toPosixPath(value).replace(/^\.\//u, ""));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Read target is outside the Context Tree: ${value}`);
  }
  return normalized.replace(/\/$/u, "");
}

function canonicalTarget(
  root: string,
  path: string | undefined,
): {
  absolutePath: string;
  kind: "directory" | "file";
  relativePath: string;
} {
  const requested = normalizeTreeTarget(path);
  const semanticPath = requested === "NODE.md" ? "" : requested.endsWith("/NODE.md") ? dirname(requested) : requested;
  if (classifyContextContent(semanticPath) === "repo-infra") {
    throw new Error(`Read target is repository infrastructure: ${requested || "."}`);
  }
  const absolutePath = resolve(root, semanticPath);
  if (!isPathInside(root, absolutePath)) throw new Error("Read target escapes the Context Tree root.");

  const entry = lstatSync(absolutePath);
  if (entry.isSymbolicLink() || (!entry.isDirectory() && !entry.isFile())) {
    throw new Error(`Read target must be a real file or directory: ${requested || "."}`);
  }
  if (realpathSync(absolutePath) !== absolutePath) {
    throw new Error(`Read target must not traverse a symlink: ${requested || "."}`);
  }

  const relativePath = toPosixPath(relative(root, absolutePath));
  if (entry.isFile() && !absolutePath.endsWith(".md")) {
    throw new Error(`Read target must be a Markdown file or indexed directory: ${requested || "."}`);
  }

  return { absolutePath, kind: entry.isDirectory() ? "directory" : "file", relativePath };
}

function readNode(path: string, relativePath: string, kind: "directory" | "file"): ContextTreeReadNode {
  const documentPath = kind === "directory" ? join(path, "NODE.md") : path;
  const entry = lstatSync(documentPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Context Tree document must be a regular file: ${relativePath || "NODE.md"}`);
  }
  const document = readNodeDocument(documentPath);
  if (document === null) {
    throw new Error(`Context Tree document has invalid or missing metadata: ${relativePath || "."}`);
  }
  return {
    body: document.body,
    contentClass: classifyContextContent(relativePath),
    frontmatter: document.frontmatter,
    kind,
    path: relativePath || ".",
  };
}

function childSummary(root: string, parentPath: string, name: string): ContextTreeReadChild | null {
  const absolutePath = join(parentPath, name);
  const relativePath = toPosixPath(relative(root, absolutePath));
  const contentClass = classifyContextContent(relativePath);
  if (contentClass === "repo-infra") return null;

  const entry = lstatSync(absolutePath);
  if (entry.isSymbolicLink()) return null;
  const kind = entry.isDirectory()
    ? "directory"
    : entry.isFile() && name.endsWith(".md") && name !== "NODE.md"
      ? "file"
      : null;
  if (kind === null) return null;

  const documentPath = kind === "directory" ? join(absolutePath, "NODE.md") : absolutePath;
  const document = readNodeDocument(documentPath);
  if (document === null) {
    throw new Error(`Context Tree child has invalid or missing metadata: ${relativePath}`);
  }
  return {
    contentClass,
    ...(document.description === undefined ? {} : { description: document.description }),
    kind,
    path: relativePath,
    title: document.title,
  };
}

export function readTree(treePath: string, path?: string): ContextTreeReadResult {
  const root = resolveTreeRoot(treePath);
  const target = canonicalTarget(root, path);
  const node = readNode(target.absolutePath, target.relativePath, target.kind);
  const children =
    target.kind === "file"
      ? []
      : readdirSync(target.absolutePath)
          .map((name) => childSummary(root, target.absolutePath, name))
          .filter((child): child is ContextTreeReadChild => child !== null)
          .sort((left, right) => left.path.localeCompare(right.path));

  return {
    children,
    node,
    root,
    schemaVersion: SCHEMA_VERSION,
    target: target.relativePath || ".",
  };
}
