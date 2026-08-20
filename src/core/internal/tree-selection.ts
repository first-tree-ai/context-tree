import { basename, dirname, posix } from "node:path";

import { toPosixPath } from "../path.js";

export function normalizeTreeTarget(value: string | undefined): string {
  if (!value || value === ".") return "";
  const normalized = posix.normalize(toPosixPath(value).replace(/^\.\//u, ""));
  if (normalized === ".." || normalized.startsWith("../") || normalized.startsWith("/")) {
    throw new Error(`Read target is outside the Context Tree: ${value}`);
  }
  return normalized.replace(/\/$/u, "");
}

export function compileSegmentLocalGlob(pattern: string): RegExp {
  let source = "^";
  for (const character of pattern) {
    if (character === "*") source += "[^/]*";
    else if (character === "?") source += "[^/]";
    else source += character.replace(/[|\\{}()[\]^$+?.]/gu, "\\$&");
  }
  return new RegExp(`${source}$`, "u");
}

function entryDepth(path: string): number {
  if (path === "." || path.length === 0) return 0;
  return path.split("/").length;
}

export function relativeTreeDepth(path: string, target: string): number {
  return Math.max(0, entryDepth(path) - entryDepth(target));
}

export function isTreeEntryWithinTarget(path: string, sourcePath: string, target: string): boolean {
  return (
    target.length === 0 ||
    path === target ||
    path.startsWith(`${target}/`) ||
    sourcePath === target ||
    sourcePath.startsWith(`${target}/`)
  );
}

function displayTitle(relativePath: string): string {
  const name = basename(relativePath, ".md");
  return name
    .split(/[-_]/u)
    .filter(Boolean)
    .map((part) => `${part[0]?.toUpperCase() ?? ""}${part.slice(1)}`)
    .join(" ");
}

export function deriveTreeEntry(
  relativePath: string,
  metadataTitle?: string,
): {
  kind: "directory" | "file";
  path: string;
  title: string;
} {
  const isNode = basename(relativePath) === "NODE.md";
  const entryPath = isNode ? dirname(relativePath).replace(/^\.$/u, ".") : relativePath;
  const normalizedPath = entryPath === "." ? "" : toPosixPath(entryPath);
  return {
    kind: isNode ? "directory" : "file",
    path: normalizedPath,
    title: metadataTitle ?? (relativePath === "SCOPE.md" ? "Scope" : displayTitle(relativePath)),
  };
}

export function compareTreeEntries(
  left: { kind: "directory" | "file"; path: string },
  right: { kind: "directory" | "file"; path: string },
): number {
  const leftParts = left.path === "." ? [] : left.path.split("/");
  const rightParts = right.path === "." ? [] : right.path.split("/");
  const sharedLength = Math.min(leftParts.length, rightParts.length);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = (leftParts[index] ?? "").localeCompare(rightParts[index] ?? "");
    if (comparison !== 0) return comparison;
  }
  return leftParts.length - rightParts.length || left.kind.localeCompare(right.kind);
}
