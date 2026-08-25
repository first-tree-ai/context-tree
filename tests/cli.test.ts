import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  contextTreeCliErrorEnvelopeSchema,
  contextTreePolicySchema,
  contextTreeReadResultSchema,
  scaffoldTreeResultSchema,
  verifyTreeReportSchema,
} from "../src/schemas.js";

const CLI = resolve(import.meta.dirname, "../dist/cli/index.mjs");
const workspaces = new Set<string>();

type CliResult = { status: number | null; stderr: string; stdout: string };

function workspace(): string {
  const path = mkdtempSync(resolve(tmpdir(), "context-tree-cli-"));
  workspaces.add(path);
  return path;
}

afterEach(() => {
  for (const path of workspaces) rmSync(path, { force: true, recursive: true });
  workspaces.clear();
});

function cli(cwd: string, args: string[]): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: "utf8" });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

const INIT_ARGS = ["--repository", "acme/context", "--tree-path", "tree", "--title", "CLI Tree"];

describe("built CLI", () => {
  it("exposes only init, policy, read, and verify", () => {
    const help = cli(workspace(), ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("scaffolding, reading, and validating Context Trees");
    expect([...help.stdout.matchAll(/^ {2}([a-z][\w-]*)\s+/gmu)].map((match) => match[1]).sort()).toEqual([
      "init",
      "policy",
      "read",
      "verify",
    ]);
    const version = cli(workspace(), ["--version"]);
    expect(version).toMatchObject({ status: 0, stderr: "", stdout: "0.1.0\n" });
  });

  it("runs init, policy, verify, and read with versioned JSON", () => {
    const cwd = workspace();
    const initialized = cli(cwd, ["init", ...INIT_ARGS]);
    expect(initialized.status).toBe(0);
    const scaffold = scaffoldTreeResultSchema.parse(JSON.parse(initialized.stdout));
    expect(scaffold.files).toEqual(["NODE.md", "SCOPE.md", ".github/workflows/validate-context-tree.yml"]);
    const workflowPath = resolve(cwd, "tree/.github/workflows/validate-context-tree.yml");
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, "utf8")).toContain('branches: ["main"]');
    expect(readFileSync(workflowPath, "utf8")).toContain("@first-tree-ai/context-tree@0.1.0 verify");

    const policy = cli(cwd, ["policy"]);
    expect(policy.status).toBe(0);
    contextTreePolicySchema.parse(JSON.parse(policy.stdout));

    const verification = cli(cwd, ["verify", "--tree-path", "tree"]);
    expect(verification.status).toBe(0);
    const verificationResult = verifyTreeReportSchema.parse(JSON.parse(verification.stdout));
    expect(verificationResult).toMatchObject({ ok: true, schemaVersion: 1 });
    const read = cli(cwd, ["read", "--tree-path", "tree", "--content"]);
    expect(read.status).toBe(0);
    const readResult = contextTreeReadResultSchema.parse(JSON.parse(read.stdout));
    expect(readResult.schemaVersion).toBe(1);
  });

  it("requires explicit GitHub identity and returns JSON errors", () => {
    const cwd = workspace();
    const missingIdentity = cli(cwd, ["init", "--tree-path", "tree", "--title", "Tree"]);
    expect(missingIdentity.status).toBe(1);
    contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(missingIdentity.stdout));
    expect(missingIdentity.stderr).toBe("");

    expect(cli(cwd, ["init", ...INIT_ARGS]).status).toBe(0);
    rmSync(resolve(cwd, "tree/NODE.md"));
    const invalid = cli(cwd, ["verify", "--tree-path", "tree"]);
    expect(invalid.status).toBe(1);
    const invalidResult = verifyTreeReportSchema.parse(JSON.parse(invalid.stdout));
    expect(invalidResult).toMatchObject({ ok: false, schemaVersion: 1 });

    const generic = cli(cwd, [
      "init",
      ...INIT_ARGS.map((value) => (value === "acme/context" ? "https://github.com/acme/context" : value)),
      "--tree-path",
      "other",
    ]);
    expect(generic.status).toBe(1);
    expect(contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(generic.stdout))).toMatchObject({
      error: { code: "CONTEXT_TREE_FAILED" },
      ok: false,
      schemaVersion: 1,
    });

    const removedFlag = cli(cwd, ["--json", "policy"]);
    expect(removedFlag.status).toBe(1);
    expect(contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(removedFlag.stdout))).toMatchObject({
      error: { code: "CONTEXT_TREE_FAILED", message: expect.stringContaining("unknown option '--json'") },
      ok: false,
      schemaVersion: 1,
    });
    expect(removedFlag.stderr).toBe("");

    const removedBaseBranch = cli(cwd, ["init", ...INIT_ARGS, "--base-branch", "trunk"]);
    expect(removedBaseBranch.status).toBe(1);
    expect(contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(removedBaseBranch.stdout))).toMatchObject({
      error: { code: "CONTEXT_TREE_FAILED", message: expect.stringContaining("unknown option '--base-branch'") },
      ok: false,
      schemaVersion: 1,
    });
    expect(removedBaseBranch.stderr).toBe("");

    const removedOwner = cli(cwd, ["init", ...INIT_ARGS, "--tree-path", "third", "--owner", "alice"]);
    expect(removedOwner.status).toBe(1);
    expect(contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(removedOwner.stdout))).toMatchObject({
      error: { code: "CONTEXT_TREE_FAILED", message: expect.stringContaining("unknown option '--owner'") },
    });
  });
});
