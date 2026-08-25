import { existsSync, realpathSync, statSync } from "node:fs";
import { posix, resolve } from "node:path";

import { fromMarkdown } from "mdast-util-from-markdown";

import { isRecord } from "../../internal/value.js";
import { isPathInside } from "../path.js";

type LocalTreeTargetStatus = "escaped-existing" | "escaped-missing" | "missing" | "valid";

function stripQueryAndFragment(target: string): string {
  const queryIndex = target.indexOf("?");
  const fragmentIndex = target.indexOf("#");
  const indexes = [queryIndex, fragmentIndex].filter((index) => index >= 0);
  const end = indexes.length === 0 ? target.length : Math.min(...indexes);
  return target.slice(0, end);
}

function decodeTarget(target: string): string {
  try {
    return decodeURIComponent(target);
  } catch {
    return target;
  }
}

function isWindowsAbsoluteTarget(target: string): boolean {
  return /^[a-z]:[\\/]/iu.test(target) || /^\\/u.test(target);
}

export function isTreeLocalTarget(target: string): boolean {
  const trimmed = target.trim();
  if (isWindowsAbsoluteTarget(decodeTarget(stripQueryAndFragment(trimmed)))) {
    return true;
  }
  return (
    trimmed.length > 0 && !trimmed.startsWith("#") && !trimmed.startsWith("//") && !/^[a-z][a-z\d+.-]*:/iu.test(trimmed)
  );
}

function targetExists(path: string, softLink: boolean): boolean {
  try {
    const stat = statSync(path);
    if (stat.isFile()) {
      return !softLink || path.endsWith(".md");
    }
    return stat.isDirectory() && (!softLink || existsSync(resolve(path, "NODE.md")));
  } catch {
    return false;
  }
}

export function resolveLocalTreeTarget(options: {
  sourcePath: string;
  target: string;
  treeRoot: string;
  softLink: boolean;
}): LocalTreeTargetStatus | null {
  if (!isTreeLocalTarget(options.target)) {
    return null;
  }

  const decodedTarget = decodeTarget(stripQueryAndFragment(options.target.trim()));
  const withoutSuffix = decodedTarget.replace(/\\/gu, "/");
  if (withoutSuffix.length === 0) {
    return null;
  }

  if (isWindowsAbsoluteTarget(decodedTarget)) {
    return "escaped-missing";
  }

  const sourceDirectory = posix.dirname(options.sourcePath);
  const relativePath = posix.normalize(
    options.softLink || withoutSuffix.startsWith("/")
      ? withoutSuffix.replace(/^\/+/, "")
      : posix.join(sourceDirectory, withoutSuffix),
  );
  const absoluteRoot = resolve(options.treeRoot);
  const absoluteTarget = resolve(absoluteRoot, relativePath);
  const lexicalEscape = !isPathInside(absoluteRoot, absoluteTarget);
  if (lexicalEscape) {
    return "escaped-missing";
  }

  const exists = targetExists(absoluteTarget, options.softLink);
  if (!exists) {
    return "missing";
  }

  try {
    const realRoot = realpathSync(absoluteRoot);
    const realTarget = realpathSync(absoluteTarget);
    if (!isPathInside(realRoot, realTarget)) {
      return "escaped-existing";
    }
  } catch {
    return "missing";
  }

  return "valid";
}

export function readMarkdownLinkTargets(markdown: string): string[] {
  const root = fromMarkdown(markdown);
  const targets: string[] = [];

  function visit(node: unknown): void {
    if (!isRecord(node)) {
      return;
    }

    if ((node.type === "link" || node.type === "image" || node.type === "definition") && typeof node.url === "string") {
      targets.push(node.url);
    }

    if (Array.isArray(node.children)) {
      for (const child of node.children) {
        visit(child);
      }
    }
  }

  visit(root);
  return targets;
}
