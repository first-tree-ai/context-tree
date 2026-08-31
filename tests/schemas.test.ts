import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { scaffoldTree } from "../src/core/scaffold.js";
import { readContextTreePolicy, readTree, verifyTree } from "../src/index.js";
import {
  connectProjectResultSchema,
  contextTreeCliErrorEnvelopeSchema,
  contextTreeConnectionResultSchema,
  contextTreePolicySchema,
  contextTreePublishResultSchema,
  contextTreeReadChildSchema,
  contextTreeReadNodeSchema,
  contextTreeReadResultSchema,
  contextTreeStateSchema,
  contextTreeSyncResultSchema,
  createProjectResultSchema,
  finishContextWriteResultSchema,
  managedTreeListingResultSchema,
  prepareContextWriteResultSchema,
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
    const read = readTree(root);
    expect(contextTreeReadNodeSchema.parse(read.node)).toEqual(read.node);
    for (const child of read.children) expect(contextTreeReadChildSchema.parse(child)).toEqual(child);
  });

  it("parses managed tree listings strictly", () => {
    const listing = {
      schemaVersion: 1,
      trees: [
        { name: "acme-context", tree: { kind: "local", path: "/tmp/tree" } },
        { name: "other", tree: { kind: "github", path: "/tmp/other", repository: "acme/other" } },
      ],
    };
    expect(managedTreeListingResultSchema.parse(listing)).toEqual(listing);
    expect(managedTreeListingResultSchema.safeParse({ schemaVersion: 1, trees: [] }).success).toBe(true);
    expect(
      managedTreeListingResultSchema.safeParse({
        schemaVersion: 1,
        trees: [{ name: "Bad/Name", tree: { kind: "local", path: "/tmp/tree" } }],
      }).success,
    ).toBe(false);
    expect(managedTreeListingResultSchema.safeParse({ schemaVersion: 2, trees: [] }).success).toBe(false);
    expect(managedTreeListingResultSchema.safeParse({ schemaVersion: 1, trees: [], extra: true }).success).toBe(false);
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

  it("defines strict connection results and specific connection errors", () => {
    const published = { schemaVersion: 1, tree: { kind: "github", path: "/work/context", repository: "acme/context" } };
    expect(contextTreeConnectionResultSchema.parse(published)).toEqual(published);
    const local = { schemaVersion: 1, tree: { kind: "local", path: "/work/context" } };
    expect(contextTreeConnectionResultSchema.parse(local)).toEqual(local);
    expect(
      contextTreeConnectionResultSchema.safeParse({
        ...local,
        tree: { kind: "local", path: "/work/context", repository: 42 },
      }).success,
    ).toBe(false);
    for (const path of ["relative/context", "/work/control\ncontext", "/work/control\tcontext"]) {
      expect(contextTreeConnectionResultSchema.safeParse({ ...local, tree: { kind: "local", path } }).success).toBe(
        false,
      );
    }
    expect(contextTreeConnectionResultSchema.safeParse({ ...local, connection: { future: true } }).success).toBe(false);
    for (const code of ["NO_CONNECTION", "CORRUPT_CONNECTION", "STALE_CONNECTION", "WRITE_OUTDATED"]) {
      expect(
        contextTreeCliErrorEnvelopeSchema.safeParse({
          error: { code, message: "connection error" },
          ok: false,
          schemaVersion: 1,
        }).success,
      ).toBe(true);
    }
    expect(
      contextTreeCliErrorEnvelopeSchema.safeParse({
        error: { code: "NO_REMOTE", message: "removed" },
        ok: false,
        schemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it("parses the discriminated tree state for local and published trees", () => {
    const local = { kind: "local", path: "/work/context" };
    const published = { kind: "github", path: "/work/context", repository: "acme/context" };
    expect(contextTreeStateSchema.parse(local)).toEqual(local);
    expect(contextTreeStateSchema.parse(published)).toEqual(published);
    for (const invalid of [
      { kind: "remote", path: "/work/context" },
      { kind: "github", path: "/work/context" },
      { kind: "local", path: "/work/context", repository: "acme/context" },
      { kind: "local", path: "relative/context" },
      { kind: "github", path: "/work/context", repository: "acme/context", extra: true },
    ]) {
      expect(contextTreeStateSchema.safeParse(invalid).success).toBe(false);
    }
  });

  it("parses the create result contract strictly", () => {
    const result = {
      branch: "trunk",
      commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      created: true,
      schemaVersion: 1,
      title: "service-context-tree",
      treePath: "/home/user/.context-tree/trees/service-context-tree",
    };
    expect(createProjectResultSchema.parse(result)).toEqual(result);
    expect(createProjectResultSchema.safeParse({ ...result, created: "yes" }).success).toBe(false);
    expect(createProjectResultSchema.safeParse({ ...result, treePath: "relative/path" }).success).toBe(false);
    expect(createProjectResultSchema.safeParse({ ...result, future: true }).success).toBe(false);
  });

  it("parses connect, sync, and prepare-write results around the tree state", () => {
    const local = { kind: "local", path: "/work/context" };
    expect(connectProjectResultSchema.parse({ schemaVersion: 1, tree: local })).toEqual({
      schemaVersion: 1,
      tree: local,
    });
    const sync = {
      branch: "trunk",
      schemaVersion: 1,
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      tree: local,
    };
    expect(contextTreeSyncResultSchema.parse(sync)).toEqual(sync);
    expect(contextTreeSyncResultSchema.safeParse({ ...sync, branch: "" }).success).toBe(false);
    const prepared = {
      schemaVersion: 1,
      worktreePath: "/tmp/context-tree-write-abc123",
    };
    expect(prepareContextWriteResultSchema.parse(prepared)).toEqual(prepared);
    expect(prepareContextWriteResultSchema.safeParse({ ...prepared, extra: 1 }).success).toBe(false);
  });

  it("parses the lean finish-write result strictly", () => {
    const result = {
      branch: "trunk",
      schemaVersion: 1,
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
    };
    expect(finishContextWriteResultSchema.parse(result)).toEqual(result);
    expect(finishContextWriteResultSchema.safeParse({ ...result, status: "applied" }).success).toBe(false);
  });

  it("parses publish results and requires a safe repository URL", () => {
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

  it("accepts the new publish and write error codes in the error envelope", () => {
    for (const code of ["GITHUB_AUTH", "REPOSITORY_EXISTS", "PUBLISH_INCOMPLETE"]) {
      expect(
        contextTreeCliErrorEnvelopeSchema.safeParse({
          error: { code, message: "publish error" },
          ok: false,
          schemaVersion: 1,
        }).success,
      ).toBe(true);
    }
  });
});
