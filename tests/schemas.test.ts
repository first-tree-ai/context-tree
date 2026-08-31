import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "../src/index.js";
import {
  connectProjectResultSchema,
  contextTreeCliErrorEnvelopeSchema,
  contextTreeLinkResultSchema,
  contextTreePolicySchema,
  contextTreePublishResultSchema,
  contextTreeReadChildSchema,
  contextTreeReadNodeSchema,
  contextTreeReadResultSchema,
  contextTreeStateSchema,
  contextTreeSyncResultSchema,
  finishContextWriteResultSchema,
  initializeProjectResultSchema,
  prepareContextWriteResultSchema,
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

  it("parses the setup result contract strictly", () => {
    const result = {
      branch: "trunk",
      commitSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      created: true,
      schemaVersion: 1,
      title: "service",
      treePath: "/home/user/.context-tree/trees/service-1a2b3c",
    };
    expect(initializeProjectResultSchema.parse(result)).toEqual(result);
    expect(initializeProjectResultSchema.safeParse({ ...result, created: "yes" }).success).toBe(false);
    expect(initializeProjectResultSchema.safeParse({ ...result, treePath: "relative/path" }).success).toBe(false);
    expect(initializeProjectResultSchema.safeParse({ ...result, future: true }).success).toBe(false);
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
      updated: false,
    };
    expect(contextTreeSyncResultSchema.parse(sync)).toEqual(sync);
    expect(contextTreeSyncResultSchema.safeParse({ ...sync, branch: "" }).success).toBe(false);
    const prepared = {
      baseSha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      schemaVersion: 1,
      taskBranch: "context-tree/write/abc123",
      tree: local,
      worktreePath: "/tmp/context-tree-write-abc123",
    };
    expect(prepareContextWriteResultSchema.parse(prepared)).toEqual(prepared);
    expect(prepareContextWriteResultSchema.safeParse({ ...prepared, extra: 1 }).success).toBe(false);
  });

  it("parses every finish-write outcome and rejects unknown statuses", () => {
    const applied = {
      branch: "trunk",
      schemaVersion: 1,
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      status: "applied",
      tree: { kind: "local", path: "/work/context" },
    };
    const pullRequest = {
      branch: "trunk",
      pullRequestUrl: "https://github.com/acme/context/pull/7",
      schemaVersion: 1,
      sha: "a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5d6e7f8a9b0",
      status: "pull-request",
      tree: { kind: "github", path: "/work/context", repository: "acme/context" },
    };
    const conflict = {
      message: "Semantic resolution required.",
      schemaVersion: 1,
      status: "conflict",
      taskBranch: "context-tree/write/abc123",
      worktreePath: "/tmp/context-tree-write-abc123",
    };
    const outdated = { ...conflict, status: "outdated" };
    for (const result of [applied, pullRequest, conflict, outdated]) {
      expect(finishContextWriteResultSchema.parse(result)).toEqual(result);
    }
    expect(finishContextWriteResultSchema.safeParse({ ...applied, status: "merged" }).success).toBe(false);
    expect(
      finishContextWriteResultSchema.safeParse({ ...applied, tree: { kind: "local", path: "relative" } }).success,
    ).toBe(false);
  });

  it("parses publish results and requires a safe repository URL", () => {
    const result = {
      branch: "trunk",
      created: true,
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
