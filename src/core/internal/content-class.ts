import type { Dirent, Stats } from "node:fs";
import { readdirSync, realpathSync, statSync } from "node:fs";
import { join, relative } from "node:path";

import type { ContextContentClass, ContextContentClassCounts } from "../../schemas.js";
import { isPathInside } from "../path.js";

type MarkdownTargetInspection =
  | { kind: "content-class-mismatch"; canonicalRelativePath: string }
  | { kind: "escaped" }
  | { kind: "regular" }
  | { kind: "unresolved" }
  | { kind: "unsupported" };

type ContextMarkdownFile = {
  absolutePath: string;
  contentClass: ContextContentClass;
  inspection: MarkdownTargetInspection;
  relativePath: string;
};

type ContextDirectorySymlink = {
  escaped: boolean;
  relativePath: string;
};

type ContextMarkdownCollection = {
  directories: string[];
  directorySymlinks: ContextDirectorySymlink[];
  files: ContextMarkdownFile[];
};

const GENERATED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const REPO_INFRA_MARKDOWN_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);
const MANAGED_SYMLINK_PATHS = new Set(["WHITEPAPER.md"]);

function toTreeRelativePosixPath(treeRoot: string, targetPath: string): string {
  return relative(treeRoot, targetPath).replace(/\\/gu, "/");
}

export function classifyContextContent(relativePath: string): ContextContentClass {
  const normalized = relativePath.replace(/\\/gu, "/").replace(/^\.\//u, "");
  const parts = normalized.split("/").filter((part) => part.length > 0);

  if (
    parts.some((part) => part.startsWith(".") || GENERATED_DIRECTORY_NAMES.has(part)) ||
    parts[0] === "scripts" ||
    REPO_INFRA_MARKDOWN_FILES.has(parts.at(-1) ?? "")
  ) {
    return "repo-infra";
  }

  if (parts[0] === "members") {
    return "member";
  }

  return "normal";
}

export function emptyContentClassCounts(): ContextContentClassCounts {
  return {
    normal: 0,
    member: 0,
    "repo-infra": 0,
  };
}

function readDirectoryEntries(path: string): Dirent[] {
  try {
    return readdirSync(path, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

type CanonicalTarget = { kind: "escaped" } | { kind: "resolved"; relativePath: string } | { kind: "unresolved" };

function canonicalTarget(realTreeRoot: string, path: string): CanonicalTarget {
  try {
    const realTarget = realpathSync(path);
    if (!isPathInside(realTreeRoot, realTarget)) return { kind: "escaped" };
    return { kind: "resolved", relativePath: toTreeRelativePosixPath(realTreeRoot, realTarget) };
  } catch {
    return { kind: "unresolved" };
  }
}

function inspectMarkdownSymlink(
  realTreeRoot: string,
  absolutePath: string,
  contentClass: ContextContentClass,
): MarkdownTargetInspection {
  let targetStat: Stats;
  try {
    targetStat = statSync(absolutePath);
  } catch {
    return { kind: "unresolved" };
  }

  const target = canonicalTarget(realTreeRoot, absolutePath);
  if (target.kind !== "resolved") return target;
  if (!targetStat.isFile()) return { kind: "unsupported" };
  if (classifyContextContent(target.relativePath) !== contentClass) {
    return { kind: "content-class-mismatch", canonicalRelativePath: target.relativePath };
  }
  return { kind: "regular" };
}

export function collectContextMarkdownContent(treeRoot: string): ContextMarkdownCollection {
  const directories: string[] = [];
  const directorySymlinks: ContextDirectorySymlink[] = [];
  const files: ContextMarkdownFile[] = [];
  const realTreeRoot = realpathSync(treeRoot);

  function walk(directoryPath: string): void {
    for (const entry of readDirectoryEntries(directoryPath)) {
      const absolutePath = join(directoryPath, entry.name);
      const relativePath = toTreeRelativePosixPath(treeRoot, absolutePath);
      const contentClass = classifyContextContent(relativePath);

      if (entry.isDirectory()) {
        if (contentClass !== "repo-infra") {
          directories.push(relativePath);
          walk(absolutePath);
        }
        continue;
      }

      const symbolicLink = entry.isSymbolicLink();
      if (symbolicLink) {
        try {
          const targetStat = statSync(absolutePath);
          if (targetStat.isDirectory()) {
            if (contentClass !== "repo-infra" || entry.name.endsWith(".md")) {
              const target = canonicalTarget(realTreeRoot, absolutePath);
              directorySymlinks.push({
                escaped: target.kind === "escaped",
                relativePath,
              });
            }
            continue;
          }
        } catch {
          if (MANAGED_SYMLINK_PATHS.has(relativePath)) {
            continue;
          }
          if (entry.name.endsWith(".md")) {
            files.push({
              absolutePath,
              contentClass,
              inspection: { kind: "unresolved" },
              relativePath,
            });
          }
          continue;
        }
      }

      if ((!entry.isFile() && !symbolicLink) || !entry.name.endsWith(".md")) {
        continue;
      }

      if (symbolicLink && MANAGED_SYMLINK_PATHS.has(relativePath)) {
        continue;
      }

      files.push({
        absolutePath,
        contentClass,
        inspection: symbolicLink
          ? inspectMarkdownSymlink(realTreeRoot, absolutePath, contentClass)
          : { kind: "regular" },
        relativePath,
      });
    }
  }

  walk(treeRoot);
  return { directories, directorySymlinks, files };
}
