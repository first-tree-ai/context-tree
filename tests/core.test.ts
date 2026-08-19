import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";
import type { ContextTreeWriteError } from "../src/index.js";
import {
  applyWritePlan,
  auditTree,
  calculateTreeDigest,
  credentialFreeRepositoryUrlSchema,
  readContextTreePolicy,
  readTree,
  scaffoldTree,
  sha256,
  verifyTree,
  WRITE_ERROR_CODES,
} from "../src/index.js";

function tempRoot(): string {
  return mkdtempSync(join(tmpdir(), "context-tree-test-"));
}

describe("portable Context Tree core", () => {
  it("scaffolds a valid tree that can be read and audited", () => {
    const root = join(tempRoot(), "tree");
    const scaffold = scaffoldTree({ owner: "alice", path: root, title: "Acme" });

    expect(scaffold.verification.ok).toBe(true);
    expect(verifyTree(root).ok).toBe(true);
    expect(readTree(root).entries.map((entry) => entry.path)).toEqual([".", "SCOPE.md"]);

    const audit = auditTree(root);
    expect(audit.verification.ok).toBe(true);
    expect(audit.entries.some((entry) => entry.contentClass === "member")).toBe(true);
  });

  it("applies a guarded write plan and rejects a stale replay", () => {
    const root = join(tempRoot(), "tree");
    scaffoldTree({ owner: "alice", path: root, title: "Acme" });
    const expectedTreeDigest = calculateTreeDigest(root);
    const content = `---\ntitle: "Systems"\nowners: [alice]\n---\n\n# Systems\n`;
    const plan = {
      schemaVersion: 1 as const,
      expectedTreeDigest,
      operations: [{ op: "create" as const, path: "systems/NODE.md", content }],
    };

    const dryRun = applyWritePlan(root, plan, { dryRun: true });
    expect(dryRun.dryRun).toBe(true);
    expect(existsSync(join(root, "systems/NODE.md"))).toBe(false);

    const applied = applyWritePlan(root, plan);
    expect(applied.dryRun).toBe(false);
    expect(existsSync(join(root, "systems/NODE.md"))).toBe(true);
    expect(verifyTree(root).ok).toBe(true);
    expect(() => applyWritePlan(root, plan)).toThrowError(
      expect.objectContaining<Partial<ContextTreeWriteError>>({ code: WRITE_ERROR_CODES.staleTree }),
    );
  });

  it("replaces content only when both tree and file digests match", () => {
    const root = join(tempRoot(), "tree");
    scaffoldTree({ owner: "alice", path: root, title: "Acme" });
    const path = join(root, "NODE.md");
    const original = readFileSync(path, "utf8");
    const replacement = original.replace("canonical home", "durable home");
    const plan = {
      schemaVersion: 1 as const,
      expectedTreeDigest: calculateTreeDigest(root),
      operations: [
        {
          op: "replace" as const,
          path: "NODE.md",
          expectedSha256: sha256(original),
          content: replacement,
        },
      ],
    };

    const applied = applyWritePlan(root, plan);
    expect(applied.dryRun).toBe(false);
    expect(readFileSync(path, "utf8")).toContain("durable home");

    expect(() => applyWritePlan(root, plan)).toThrowError(
      expect.objectContaining<Partial<ContextTreeWriteError>>({ code: WRITE_ERROR_CODES.staleTree }),
    );
  });

  it("reports invalid links without following an escape", () => {
    const root = join(tempRoot(), "tree");
    scaffoldTree({ owner: "alice", path: root, title: "Acme" });
    writeFileSync(join(root, "bad.md"), `---\ntitle: "Bad link"\nowners: [alice]\n---\n\n[Outside](../secret.md)\n`);

    const report = verifyTree(root);
    expect(report.ok).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({ code: "TREE_MARKDOWN_LINK_PATH_ESCAPE", path: "bad.md" }),
    );
  });

  it("requires every content directory to have a NODE.md", () => {
    const root = join(tempRoot(), "tree");
    scaffoldTree({ owner: "alice", path: root, title: "Acme" });
    const bareDirectory = join(root, "bare");
    const nested = join(bareDirectory, "placeholder.md");
    mkdirSync(bareDirectory);
    writeFileSync(nested, `---\ntitle: "Placeholder"\nowners: [alice]\n---\n`);

    expect(verifyTree(root).findings).toContainEqual(
      expect.objectContaining({ code: "TREE_DIRECTORY_NODE_MISSING", path: "bare/NODE.md" }),
    );
  });

  it("ships a readable policy and accepts only credential-free repository URLs", () => {
    const policy = readContextTreePolicy();
    expect(policy.content).toContain("# Context Tree Policy");
    expect(policy.digest).toMatch(/^[a-f\d]{64}$/u);

    expect(credentialFreeRepositoryUrlSchema.safeParse("https://github.com/acme/private-tree.git").success).toBe(true);
    expect(credentialFreeRepositoryUrlSchema.safeParse("git@github.com:acme/private-tree.git").success).toBe(true);
    expect(credentialFreeRepositoryUrlSchema.safeParse("https://token@github.com/acme/private-tree.git").success).toBe(
      false,
    );
    expect(
      credentialFreeRepositoryUrlSchema.safeParse("https://github.com/acme/private-tree.git?token=secret").success,
    ).toBe(false);
  });
});
