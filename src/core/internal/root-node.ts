import { lstatSync } from "node:fs";
import { join } from "node:path";

import { parseMarkdownFrontmatter } from "../../internal/frontmatter.js";
import {
  CONTEXT_TREE_ROOT_NODE_MAX_BYTES,
  type ContextTreeRootNode,
  contextTreeRootNodeSchema,
} from "../../schemas.js";
import { readUtf8File } from "./filesystem.js";

/**
 * The one root NODE.md reader. Verification and tree-state resolution both need
 * it, and they must agree on the fail-closed file guard, so it lives here rather
 * than in either caller: tree-state already imports verify, so a shared helper
 * in verify would close a cycle.
 */

/** Parse root NODE.md content, bounding size before any YAML or Markdown work. */
export function parseContextTreeRootNode(markdown: string): ContextTreeRootNode {
  if (Buffer.byteLength(markdown, "utf8") > CONTEXT_TREE_ROOT_NODE_MAX_BYTES) {
    throw new Error(`Root NODE.md exceeds the ${CONTEXT_TREE_ROOT_NODE_MAX_BYTES}-byte limit.`);
  }
  const document = parseMarkdownFrontmatter(markdown);
  if (document.frontmatter === "missing") {
    throw new Error("Root NODE.md must contain YAML frontmatter.");
  }
  if (document.frontmatter === "invalid") {
    throw new Error(`Root NODE.md frontmatter is invalid: ${document.error}`);
  }
  return contextTreeRootNodeSchema.parse({ frontmatter: document.data, body: document.body });
}

/** Read and parse a tree's root NODE.md, refusing symlinked or irregular files. */
export function readRootNode(root: string): ContextTreeRootNode {
  const path = join(root, "NODE.md");
  const entry = lstatSync(path);
  if (entry.isSymbolicLink() || !entry.isFile()) {
    throw new Error("Root NODE.md must be a regular file and must not be a symlink.");
  }
  return parseContextTreeRootNode(readUtf8File(path));
}
