import { lstatSync } from "node:fs";
import { resolve } from "node:path";

import {
  type ContextContentClass,
  type ContextTreeReadEntry,
  type ContextTreeReadResult,
  SCHEMA_VERSION,
} from "../schemas.js";
import {
  classifyContextContent,
  collectContextMarkdownContent,
  isSafeCanonicalMarkdown,
} from "./internal/content-class.js";
import { readNodeMetadata } from "./internal/context-document.js";
import { readUtf8File } from "./internal/filesystem.js";
import {
  compareTreeEntries,
  compileSegmentLocalGlob,
  deriveTreeEntry,
  isTreeEntryWithinTarget,
  normalizeTreeTarget,
  relativeTreeDepth,
} from "./internal/tree-selection.js";
import { isPathInside, resolveTreeRoot } from "./path.js";

export type ReadTreeOptions = {
  classes?: ContextContentClass[] | "all";
  content?: boolean;
  depth?: number;
  path?: string;
  pattern?: string;
};

function allSafeMarkdown(root: string): Array<{
  absolutePath: string;
  contentClass: ContextContentClass;
  relativePath: string;
}> {
  return collectContextMarkdownContent(root)
    .files.filter(isSafeCanonicalMarkdown)
    .map((file) => ({
      absolutePath: file.absolutePath,
      contentClass: file.contentClass,
      relativePath: file.relativePath,
    }))
    .sort((left, right) => left.relativePath.localeCompare(right.relativePath));
}

export function readTree(treePath: string, options: ReadTreeOptions = {}): ContextTreeReadResult {
  const root = resolveTreeRoot(treePath);
  const target = normalizeTreeTarget(options.path);
  const absoluteTarget = resolve(root, target);
  if (!isPathInside(root, absoluteTarget)) throw new Error("Read target escapes the Context Tree root.");
  const targetEntry = lstatSync(absoluteTarget);
  if (targetEntry.isSymbolicLink() || (!targetEntry.isDirectory() && !targetEntry.isFile())) {
    throw new Error(`Read target must be a real file or directory: ${target || "."}`);
  }

  const classes = options.classes ?? ["normal"];
  const pattern = options.pattern ? compileSegmentLocalGlob(options.pattern) : null;
  const entries: ContextTreeReadEntry[] = [];

  for (const file of allSafeMarkdown(root)) {
    if (classes !== "all" && !classes.includes(file.contentClass)) continue;

    const metadata = readNodeMetadata(file.absolutePath);
    const entry = deriveTreeEntry(file.relativePath, metadata?.title);
    if (!isTreeEntryWithinTarget(entry.path, file.relativePath, target)) continue;
    const depth = relativeTreeDepth(entry.path, target);
    if (options.depth !== undefined && depth > options.depth) continue;
    const candidates = [entry.path, file.relativePath, entry.title, metadata?.description ?? ""];
    if (pattern && !candidates.some((candidate) => pattern.test(candidate))) continue;

    const source = readUtf8File(file.absolutePath);
    entries.push({
      contentClass: file.contentClass,
      depth,
      kind: entry.kind,
      path: entry.path || ".",
      title: entry.title,
      ...(metadata?.description ? { description: metadata.description } : {}),
      ...(options.content ? { content: source } : {}),
    });
  }

  return {
    entries: entries.sort(compareTreeEntries),
    root,
    schemaVersion: SCHEMA_VERSION,
    target: target || ".",
  };
}

export function classifyTreePath(path: string): ContextContentClass {
  return classifyContextContent(path);
}
