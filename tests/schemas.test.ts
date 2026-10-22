import { describe, expect, it } from "vitest";
import { branchSchema, projectConfigSchema, treeSourceSchema } from "../src/contracts/index.js";
import { isPathInside } from "../src/tree/path.js";

describe("source contracts", () => {
  it("requires explicit Git branch/subtree and normalizes repository identity", () => {
    expect(
      treeSourceSchema.parse({ kind: "git", repository: "Acme/Knowledge", path: "docs", ref: "team/context" }),
    ).toEqual({ kind: "git", repository: "acme/knowledge", path: "docs", ref: "team/context" });
    for (const source of [
      { kind: "local", path: "/tmp/tree" },
      { kind: "github", repository: "acme/repo" },
      { kind: "git", repository: "acme/repo", path: "docs" },
      { kind: "git", repository: "https://secret@github.com/acme/repo", path: ".", ref: "main" },
      { kind: "directory", path: "docs", publish: true },
    ])
      expect(treeSourceSchema.safeParse(source).success).toBe(false);
  });
  it("rejects traversal and Git ref expressions before filesystem or network access", () => {
    for (const path of ["../docs", "docs/../other", "/docs", "docs//tree", "docs\\tree", ".git/docs", "./docs", ""]) {
      expect(
        treeSourceSchema.safeParse({ kind: "git", repository: "acme/tree", path, ref: "main" }).success,
        path,
      ).toBe(false);
    }
    for (const ref of [
      "HEAD~1",
      "main:other",
      "-x",
      "main.lock",
      "main..bad",
      "a/.hidden",
      "main@{1}",
      "a//b",
      "a?b",
      "",
    ])
      expect(branchSchema.safeParse(ref).success, ref).toBe(false);
    expect(isPathInside("/tree", "/tree/..notes")).toBe(true);
    expect(isPathInside("/tree", "/tree-other")).toBe(false);
  });
  it("rejects old config and unknown fields", () => {
    expect(projectConfigSchema.safeParse({ schemaVersion: 2, trees: {} }).success).toBe(false);
    expect(projectConfigSchema.safeParse({ schemaVersion: 3, trees: [], registry: {} }).success).toBe(false);
    expect(
      projectConfigSchema.safeParse({ schemaVersion: 3, trees: { "../bad": { kind: "directory", path: "docs" } } })
        .success,
    ).toBe(false);
  });
});
