import { createHash } from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";
import { basename, dirname, posix, resolve } from "node:path";

import type { ContextContentClass } from "../schemas.js";
import { classifyContextContent, collectContextMarkdownContent } from "./internal/content-class.js";
import { readNodeMetadata } from "./internal/context-document.js";
import { isPathInside, resolveTreeRoot, toPosixPath } from "./path.js";

export type ContextTreeReadEntry = {
  content?: string;
  contentClass: ContextContentClass;
  depth: number;
  description?: string;
  digest: string;
  kind: "directory" | "file";
  owners: string[];
  path: string;
  title: string;
};

export type ReadTreeOptions = {
  classes?: ContextContentClass[] | "all";
  content?: boolean;
  depth?: number;
  path?: string;
  pattern?: string;
};

export type ContextTreeReadResult = {
  entries: ContextTreeReadEntry[];
  root: string;
  schemaVersion: 1;
  target: string;
  treeDigest: string;
};

export function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function readUtf8(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

function normalizedTarget(value: string | undefined): string {
  if (!value || value === ".") return "";
  const normalized = posix.normalize(toPosixPath(value).replace(/^\.\//u, ""));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Read target is outside the Context Tree: ${value}`);
  }
  return normalized.replace(/\/$/u, "");
}

function globToRegex(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += ".*";
    else if (character === "?") source += ".";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "iu");
}

function entryDepth(path: string): number {
  if (path === "." || path.length === 0) return 0;
  return path.split("/").length;
}

function isWithinTarget(path: string, target: string): boolean {
  return target.length === 0 || path === target || path.startsWith(`${target}/`);
}

function relativeDepth(path: string, target: string): number {
  return Math.max(0, entryDepth(path) - entryDepth(target));
}

function displayTitle(relativePath: string): string {
  const name = basename(relativePath, ".md");
  return name
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

function compareTreePaths(left: ContextTreeReadEntry, right: ContextTreeReadEntry): number {
  const leftParts = left.path === "." ? [] : left.path.split("/");
  const rightParts = right.path === "." ? [] : right.path.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = (leftParts[index] ?? "").localeCompare(rightParts[index] ?? "");
    if (comparison !== 0) return comparison;
  }
  return leftParts.length - rightParts.length;
}

function allSafeMarkdown(root: string): Array<{
  absolutePath: string;
  contentClass: ContextContentClass;
  relativePath: string;
}> {
  return collectContextMarkdownContent(root)
    .files.filter(
      (file) =>
        file.contentClass !== "repo-infra" &&
        !file.escaped &&
        !file.unresolved &&
        !file.unsupported &&
        file.canonicalContentClass === file.contentClass,
    )
    .map((file) => ({
      absolutePath: file.absolutePath,
      contentClass: file.contentClass,
      relativePath: file.relativePath,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function calculateTreeDigest(treePath: string): string {
  const root = resolveTreeRoot(treePath);
  const hash = createHash("sha256");
  for (const file of allSafeMarkdown(root)) {
    hash.update(file.relativePath);
    hash.update("\0");
    hash.update(readFileSync(file.absolutePath));
    hash.update("\0");
  }
  return hash.digest("hex");
}

export function readTree(treePath: string, options: ReadTreeOptions = {}): ContextTreeReadResult {
  const root = resolveTreeRoot(treePath);
  const target = normalizedTarget(options.path);
  const absoluteTarget = resolve(root, target);
  if (!isPathInside(root, absoluteTarget)) throw new Error("Read target escapes the Context Tree root.");
  const targetEntry = lstatSync(absoluteTarget);
  if (targetEntry.isSymbolicLink() || (!targetEntry.isDirectory() && !targetEntry.isFile())) {
    throw new Error(`Read target must be a real file or directory: ${target || "."}`);
  }

  const classes = options.classes ?? ["normal"];
  const pattern = options.pattern ? globToRegex(options.pattern) : null;
  const entries: ContextTreeReadEntry[] = [];

  for (const file of allSafeMarkdown(root)) {
    if (classes !== "all" && !classes.includes(file.contentClass)) continue;

    const isNode = basename(file.relativePath) === "NODE.md";
    const path = isNode ? dirname(file.relativePath).replace(/^\.$/u, ".") : file.relativePath;
    const normalizedPath = path === "." ? "" : toPosixPath(path);
    if (!isWithinTarget(normalizedPath, target)) continue;
    if (options.depth !== undefined && relativeDepth(normalizedPath, target) > options.depth) continue;

    const metadata = file.relativePath === "SCOPE.md" ? null : readNodeMetadata(file.absolutePath);
    const title = metadata?.title ?? (file.relativePath === "SCOPE.md" ? "Scope" : displayTitle(file.relativePath));
    const candidates = [normalizedPath, file.relativePath, title, metadata?.description ?? ""];
    if (pattern && !candidates.some((candidate) => pattern.test(candidate))) continue;

    const source = readUtf8(file.absolutePath);
    entries.push({
      contentClass: file.contentClass,
      depth: relativeDepth(normalizedPath, target),
      digest: sha256(source),
      kind: isNode ? "directory" : "file",
      owners: metadata?.owners ?? [],
      path: normalizedPath || ".",
      title,
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(options.content ? { content: source } : {}),
    });
  }

  return {
    entries: entries.sort(compareTreePaths),
    root,
    schemaVersion: 1,
    target: target || ".",
    treeDigest: calculateTreeDigest(root),
  };
}

export function classifyTreePath(path: string): ContextContentClass {
  return classifyContextContent(path);
}
