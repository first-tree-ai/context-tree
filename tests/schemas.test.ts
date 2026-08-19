import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import {
  contextContentClassCountsSchema,
  contextTreeCliErrorEnvelopeSchema,
  contextTreePolicySchema,
  contextTreeReadEntrySchema,
  contextTreeReadResultSchema,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  scaffoldTreeResultSchema,
  treeValidationFindingSchema,
  validationCodeSchema,
  verifyTree,
  verifyTreeReportSchema,
} from "../src/index.js";

function tree(): string {
  const root = join(mkdtempSync(join(tmpdir(), "context-tree-schema-")), "tree");
  scaffoldTree({ owner: "alice", path: root, repository: "acme/context", title: "Schema Tree" });
  return root;
}

describe("public JSON schemas", () => {
  it("parses every library result without changing serialized form", () => {
    const root = tree();
    const results: Array<readonly [unknown, { parse: (value: unknown) => unknown }]> = [
      [readContextTreePolicy(), contextTreePolicySchema],
      [verifyTree(root), verifyTreeReportSchema],
      [readTree(root, { classes: "all", content: true }), contextTreeReadResultSchema],
    ];
    for (const [result, schema] of results) expect(schema.parse(result)).toEqual(result);
    const scaffoldRoot = join(mkdtempSync(join(tmpdir(), "context-tree-schema-")), "tree");
    const scaffold = scaffoldTree({
      owner: "alice",
      path: scaffoldRoot,
      repository: "acme/other",
      title: "Other",
    });
    expect(scaffoldTreeResultSchema.parse(scaffold)).toEqual(scaffold);
    for (const entry of readTree(root).entries) expect(contextTreeReadEntrySchema.parse(entry)).toEqual(entry);
  });

  it("contains no digest fields", () => {
    const root = tree();
    const policy = readContextTreePolicy();
    const read = readTree(root, { classes: "all" });
    const verification = verifyTree(root);
    expect(policy).not.toHaveProperty("digest");
    expect(read).not.toHaveProperty("treeDigest");
    expect(read.entries.every((entry) => !("digest" in entry))).toBe(true);
    expect(verification).not.toHaveProperty("treeDigest");
  });

  it("rejects incompatible versions, malformed structures, and unknown codes", () => {
    const root = tree();
    const policy = readContextTreePolicy();
    const read = readTree(root);
    expect(contextTreePolicySchema.safeParse({ ...policy, schemaVersion: 2 }).success).toBe(false);
    expect(contextTreeReadResultSchema.safeParse({ ...read, entries: undefined }).success).toBe(false);
    expect(contextTreeReadEntrySchema.safeParse({ ...read.entries[0], kind: "link" }).success).toBe(false);
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
