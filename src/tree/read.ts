import { lstatSync, readdirSync, realpathSync } from "node:fs";
import { dirname, join, posix, relative, resolve } from "node:path";

import {
  type ContextTreeReadChild,
  type ContextTreeReadHeading,
  type ContextTreeReadNode,
  type ContextTreeReadResult,
  SCHEMA_VERSION,
} from "../contracts/index.js";
import { classifyContextContent } from "./content-class.js";
import { readNodeDocument, readUtf8File } from "./document.js";
import { isPathInside, resolveTreeRoot, toPosixPath } from "./path.js";
import { readRootNode } from "./root.js";

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

export type ReadTreeOptions = {
  /** Include the whole document body. */
  full?: boolean;
  /** Include only the section under this heading (case-insensitive), with its subsections. */
  section?: string;
};

const HEADING = /^(#{1,6})[ \t]+(.+?)[ \t]*#*[ \t]*$/u;
const FENCE = /^[ \t]{0,3}(`{3,}|~{3,})/u;

/** Headings outside fenced code, with 1-based line numbers in the whole file. */
function outlineOf(lines: readonly string[], firstLine: number): ContextTreeReadHeading[] {
  const headings: ContextTreeReadHeading[] = [];
  let fence: string | null = null;
  lines.forEach((text, index) => {
    const marker = FENCE.exec(text)?.[1];
    if (marker !== undefined) {
      if (fence === null) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    if (fence !== null) return;
    const match = HEADING.exec(text);
    if (match?.[1] && match[2]) headings.push({ level: match[1].length, line: firstLine + index, title: match[2] });
  });
  return headings;
}

function sectionOf(
  lines: readonly string[],
  firstLine: number,
  outline: readonly ContextTreeReadHeading[],
  wanted: string,
  relativePath: string,
): string {
  const key = wanted.trim().toLowerCase();
  const start = outline.findIndex((heading) => heading.title.trim().toLowerCase() === key);
  const heading = outline[start];
  if (heading === undefined) throw new Error(`Section not found in ${relativePath || "."}: ${wanted}`);
  const next = outline.slice(start + 1).find((candidate) => candidate.level <= heading.level);
  const end = next === undefined ? lines.length : next.line - firstLine;
  return lines
    .slice(heading.line - firstLine, end)
    .join("\n")
    .trimEnd();
}

function readNode(
  path: string,
  relativePath: string,
  kind: "directory" | "file",
  options: ReadTreeOptions,
): ContextTreeReadNode {
  const documentPath = kind === "directory" ? join(path, "NODE.md") : path;
  const entry = lstatSync(documentPath);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error(`Context Tree document must be a regular file: ${relativePath || "NODE.md"}`);
  }
  const document = readNodeDocument(documentPath);
  if (document === null) {
    throw new Error(`Context Tree document has invalid or missing metadata: ${relativePath || "."}`);
  }
  const source = readUtf8File(documentPath);
  const firstLine = source.slice(0, source.length - document.body.length).split("\n").length;
  const lines = document.body.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const outline = outlineOf(lines, firstLine);
  const selected =
    options.section !== undefined
      ? { body: sectionOf(lines, firstLine, outline, options.section, relativePath), section: options.section }
      : options.full
        ? { body: document.body }
        : {};
  return {
    ...selected,
    contentClass: classifyContextContent(relativePath),
    frontmatter: document.frontmatter,
    kind,
    lineCount: firstLine - 1 + lines.length,
    outline,
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
  const documentEntry = lstatSync(documentPath);
  if (documentEntry.isSymbolicLink() || !documentEntry.isFile())
    throw new Error(`Context Tree child must be a regular file: ${relativePath}`);
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

export function readTree(treePath: string, path?: string, options: ReadTreeOptions = {}): ContextTreeReadResult {
  if (options.full && options.section !== undefined) throw new Error("Choose --full or --section.");
  const root = resolveTreeRoot(treePath);
  readRootNode(root);
  const target = canonicalTarget(root, path);
  const node = readNode(target.absolutePath, target.relativePath, target.kind, options);
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
