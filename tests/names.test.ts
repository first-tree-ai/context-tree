import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const IGNORED = new Set([".git", "dist", "node_modules"]);
const ALLOWED_IDENTIFIERS = [
  "@first-tree-ai/context-tree",
  "first-tree-ai/context-tree",
  "first-tree-ai",
  "First Tree AI",
];

function files(directory: string): string[] {
  const result: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (IGNORED.has(entry.name)) continue;
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...files(path));
    else if (entry.isFile()) result.push(path);
  }
  return result;
}

describe("framework-neutral naming", () => {
  it("allows only canonical package, repository, and author identifiers", () => {
    const violations: string[] = [];
    for (const path of files(ROOT)) {
      const source = readFileSync(path, "utf8");
      const withoutAllowedIdentifiers = ALLOWED_IDENTIFIERS.reduce(
        (result, identifier) => result.replaceAll(identifier, ""),
        source,
      );
      if (/first(?:-| )tree/iu.test(withoutAllowedIdentifiers)) {
        violations.push(path.slice(ROOT.length + 1));
      }
    }
    expect(violations).toEqual([]);
  });
});
