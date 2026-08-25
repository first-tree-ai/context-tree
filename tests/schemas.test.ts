import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  contextContentClassCountsSchema,
  contextTreeCliErrorEnvelopeSchema,
  contextTreePolicySchema,
  contextTreeReadEntrySchema,
  contextTreeReadResultSchema,
  contextTreeRootNodeFrontmatterSchema,
  contextTreeRootNodeSchema,
  parseContextTreeRootNode,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  scaffoldTreeResultSchema,
  treeValidationFindingSchema,
  validationCodeSchema,
  verifyTree,
  verifyTreeReportSchema,
} from "../src/index.js";

const temporaryRoots = new Set<string>();

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-schema-"));
  temporaryRoots.add(root);
  return root;
}

function tree(): string {
  const root = join(tempRoot(), "tree");
  scaffoldTree({ path: root, repository: "acme/context" });
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
      [readTree(root, { classes: "all", content: true }), contextTreeReadResultSchema],
    ];
    for (const [result, schema] of results) expect(schema.parse(result)).toEqual(result);
    const scaffoldRoot = join(tempRoot(), "tree");
    const scaffold = scaffoldTree({
      path: scaffoldRoot,
      repository: "acme/other",
    });
    expect(scaffoldTreeResultSchema.parse(scaffold)).toEqual(scaffold);
    for (const entry of readTree(root).entries) expect(contextTreeReadEntrySchema.parse(entry)).toEqual(entry);
  });

  it("rejects incompatible versions, malformed structures, and unknown codes", () => {
    const root = tree();
    const policy = readContextTreePolicy();
    const read = readTree(root);
    expect(contextTreePolicySchema.safeParse({ ...policy, schemaVersion: 2 }).success).toBe(false);
    expect(contextTreeReadResultSchema.safeParse({ ...read, entries: undefined }).success).toBe(false);
    expect(contextTreeReadEntrySchema.safeParse({ ...read.entries[0], kind: "link" }).success).toBe(false);
    expect(contextTreeReadEntrySchema.safeParse({ ...read.entries[0], owners: ["alice"] }).success).toBe(false);
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

  it("exports the root NODE parser and schemas", () => {
    const parsed = parseContextTreeRootNode('---\nschemaVersion: 1\ntitle: "Root"\ncustom: true\n---\n\n# Root\n');
    expect(contextTreeRootNodeFrontmatterSchema.parse(parsed.frontmatter)).toEqual(parsed.frontmatter);
    expect(contextTreeRootNodeSchema.parse(parsed)).toEqual(parsed);
  });

  it("rejects unknown output properties, including former digest fields", () => {
    const root = tree();
    const policy = readContextTreePolicy();
    const read = readTree(root);
    const report = verifyTree(tree());
    expect(contextTreePolicySchema.safeParse({ ...policy, digest: "a".repeat(64) }).success).toBe(false);
    expect(contextTreeReadResultSchema.safeParse({ ...read, treeDigest: "a".repeat(64) }).success).toBe(false);
    expect(contextTreeReadEntrySchema.safeParse({ ...read.entries[0], digest: "a".repeat(64) }).success).toBe(false);
    expect(verifyTreeReportSchema.safeParse({ ...report, treeDigest: "a".repeat(64) }).success).toBe(false);
    expect(verifyTreeReportSchema.safeParse({ ...report, future: true }).success).toBe(false);
    expect(contextContentClassCountsSchema.safeParse({ ...report.scannedByContentClass, future: 1 }).success).toBe(
      false,
    );
  });
});
