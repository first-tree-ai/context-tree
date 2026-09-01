import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { scaffoldTree } from "../src/core/scaffold.js";
import { readContextTreePolicy, readTree, verifyTree } from "../src/index.js";
import {
  contextTreeCliErrorEnvelopeSchema,
  contextTreePolicySchema,
  contextTreePublishResultSchema,
  contextTreeReadChildSchema,
  contextTreeReadNodeSchema,
  contextTreeReadResultSchema,
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

/**
 * The wire contracts are exercised end to end in cli.test.ts, which parses real
 * command output through these schemas. These cases cover only what that cannot:
 * that library results serialize unchanged, and that the two hand-written
 * refinements actually refuse unsafe values.
 */
describe("public JSON schemas", () => {
  it("parses every library result without changing serialized form", () => {
    const root = tree();
    const results: Array<readonly [unknown, { parse: (value: unknown) => unknown }]> = [
      [readContextTreePolicy(), contextTreePolicySchema],
      [verifyTree(root), verifyTreeReportSchema],
      [readTree(root), contextTreeReadResultSchema],
    ];
    for (const [result, schema] of results) expect(schema.parse(result)).toEqual(result);
    const read = readTree(root);
    expect(contextTreeReadNodeSchema.parse(read.node)).toEqual(read.node);
    for (const child of read.children) expect(contextTreeReadChildSchema.parse(child)).toEqual(child);
  });

  it("refuses credential-bearing publish URLs and malformed repository identities", () => {
    const result = {
      branch: "trunk",
      repository: "acme/service-context",
      schemaVersion: 1,
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      url: "https://github.com/acme/service-context.git",
    };
    expect(contextTreePublishResultSchema.parse(result)).toEqual(result);
    expect(
      contextTreePublishResultSchema.safeParse({ ...result, url: "https://token@github.com/acme/service-context.git" })
        .success,
    ).toBe(false);
    expect(contextTreePublishResultSchema.safeParse({ ...result, repository: "acme" }).success).toBe(false);
  });

  it("accepts every lifecycle error code and rejects retired ones", () => {
    const codes = [
      "CONTEXT_TREE_FAILED",
      "CORRUPT_CONNECTION",
      "DIRTY_TREE",
      "GITHUB_AUTH",
      "INVALID_TREE",
      "NO_CONNECTION",
      "PUBLISH_INCOMPLETE",
      "REPOSITORY_EXISTS",
      "STALE_CONNECTION",
      "WRITE_OUTDATED",
    ];
    for (const code of codes) {
      const envelope = { error: { code, message: "failure" }, ok: false, schemaVersion: 1 };
      expect(contextTreeCliErrorEnvelopeSchema.safeParse(envelope).success, code).toBe(true);
    }
    expect(
      contextTreeCliErrorEnvelopeSchema.safeParse({
        error: { code: "NO_LINK", message: "retired" },
        ok: false,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });
});
