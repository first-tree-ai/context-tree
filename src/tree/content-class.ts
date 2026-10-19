import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ContextContentClass } from "../contracts/index.js";

const GENERATED_DIRECTORY_NAMES = new Set(["node_modules", "__pycache__", "dist", "build", ".next", ".turbo"]);
const REPO_INFRA_MARKDOWN_FILES = new Set(["AGENTS.md", "CLAUDE.md"]);

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

export function collectContextMarkdownContent(treeRoot: string): {
  directories: string[];
  symlinks: string[];
  files: { absolutePath: string; relativePath: string; contentClass: ContextContentClass }[];
} {
  const directories: string[] = [];
  const symlinks: string[] = [];
  const files: { absolutePath: string; relativePath: string; contentClass: ContextContentClass }[] = [];
  function walk(directory: string): void {
    const entries = readdirSync(join(treeRoot, directory), { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      const relativePath = directory ? `${directory}/${entry.name}` : entry.name;
      const contentClass = classifyContextContent(relativePath);
      if (entry.isSymbolicLink()) {
        if (contentClass !== "repo-infra" || entry.name.endsWith(".md")) symlinks.push(relativePath);
      } else if (entry.isDirectory() && contentClass !== "repo-infra") {
        directories.push(relativePath);
        walk(relativePath);
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        files.push({ absolutePath: join(treeRoot, relativePath), relativePath, contentClass });
      }
    }
  }
  walk("");
  return { directories, symlinks, files };
}
