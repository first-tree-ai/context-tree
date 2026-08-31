import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "../src/index.js";
import {
  contextTreeCliErrorEnvelopeSchema,
  contextTreeLinkResultSchema,
  contextTreePolicySchema,
  contextTreeReadChildSchema,
  contextTreeReadNodeSchema,
  contextTreeReadResultSchema,
  scaffoldTreeResultSchema,
  treeValidationFindingSchema,
  validationCodeSchema,
  verifyTreeReportSchema,
} from "../src/schemas.js";

const temporaryRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-schema-"));
  temporaryRoots.add(root);
  return root;
}

function tree(): string {
  const root = join(tempRoot(), "tree");
  scaffoldTree({ path: root, name: "context" });
  return root;
}

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

describe("public JSON schemas", () => {
  it("parses every library result without changing serialized form", () => {
    const root = tree();
    const results: Array<readonly [unknown, { parse: (value: unknown) => unknown }]> = [
      [readContextTreePolicy(), contextTreePolicySchema],
      [verifyTree(root), verifyTreeReportSchema],
      [readTree(root), contextTreeReadResultSchema],
    ];
    for (const [result, schema] of results) expect(schema.parse(result)).toEqual(result);
    const scaffoldRoot = join(tempRoot(), "tree");
    const scaffold = scaffoldTree({
      name: "other",
      path: scaffoldRoot,
    });
    expect(scaffoldTreeResultSchema.parse(scaffold)).toEqual(scaffold);
    const read = readTree(root);
    expect(contextTreeReadNodeSchema.parse(read.node)).toEqual(read.node);
    for (const child of read.children) expect(contextTreeReadChildSchema.parse(child)).toEqual(child);
  });

  it("rejects incompatible versions, malformed structures, and unknown codes", () => {
    const root = tree();
    const policy = readContextTreePolicy();
    const read = readTree(root);
    expect(contextTreePolicySchema.safeParse({ ...policy, schemaVersion: 2 }).success).toBe(false);
    expect(contextTreeReadResultSchema.safeParse({ ...read, node: undefined }).success).toBe(false);
    expect(contextTreeReadNodeSchema.safeParse({ ...read.node, kind: "link" }).success).toBe(false);
    expect(contextTreeReadNodeSchema.safeParse({ ...read.node, owners: ["alice"] }).success).toBe(false);
    expect(validationCodeSchema.safeParse("TREE_NOT_A_REAL_CODE").success).toBe(false);
    expect(
      treeValidationFindingSchema.safeParse({ code: "TREE_NOT_A_REAL_CODE", message: "bad", path: "NODE.md" }).success,
    ).toBe(false);
    expect(
      contextTreeCliErrorEnvelopeSchema.safeParse({
        error: { code: "BAD", message: "bad" },
        ok: false,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("defines strict link results and specific link errors", () => {
    const link = {
      link: {
        project: { kind: "git", origin: "https://github.com/acme/service.git" },
        tree: { path: "/work/context", repository: "acme/context" },
      },
      schemaVersion: 1,
    };
    expect(contextTreeLinkResultSchema.parse(link)).toEqual(link);
    const localLink = {
      ...link,
      link: { ...link.link, tree: { path: "/work/local" } },
    };
    expect(contextTreeLinkResultSchema.parse(localLink)).toEqual(localLink);
    expect(
      contextTreeLinkResultSchema.safeParse({
        ...localLink,
        link: { ...localLink.link, tree: { path: "/work/local", repository: 42 } },
      }).success,
    ).toBe(false);
    for (const path of ["relative/context", "/work/control\ncontext", "/work/control\tcontext"]) {
      expect(
        contextTreeLinkResultSchema.safeParse({
          ...link,
          link: { ...link.link, tree: { ...link.link.tree, path } },
        }).success,
      ).toBe(false);
    }
    expect(
      contextTreeLinkResultSchema.safeParse({
        ...link,
        link: { ...link.link, future: true },
      }).success,
    ).toBe(false);
    for (const code of ["NO_LINK", "AMBIGUOUS_LINK", "CORRUPT_LINK", "STALE_LINK", "NO_REMOTE", "NO_COMMITS"]) {
      expect(
        contextTreeCliErrorEnvelopeSchema.safeParse({
          error: { code, message: "link error" },
          ok: false,
          schemaVersion: 1,
        }).success,
      ).toBe(true);
    }
  });
});
