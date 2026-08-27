import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import {
  contextTreeCliErrorEnvelopeSchema,
  contextTreeLinkResultSchema,
  contextTreePolicySchema,
  contextTreeReadResultSchema,
  contextTreeStageResultSchema,
  scaffoldTreeResultSchema,
  verifyTreeReportSchema,
} from "../src/schemas.js";

const CLI = resolve(import.meta.dirname, "../dist/cli/index.mjs");
const workspaces = new Set<string>();

type CliResult = { status: number | null; stderr: string; stdout: string };

function expectCliError(result: CliResult, code: string): ReturnType<typeof contextTreeCliErrorEnvelopeSchema.parse> {
  expect(result.status).toBe(1);
  expect(result.stderr).toBe("");
  const envelope = contextTreeCliErrorEnvelopeSchema.parse(JSON.parse(result.stdout));
  expect(envelope.error.code).toBe(code);
  return envelope;
}

function workspace(): string {
  const path = mkdtempSync(resolve(tmpdir(), "context-tree-cli-"));
  workspaces.add(path);
  writeFileSync(resolve(path, "gitconfig"), "[init]\n\tdefaultBranch = trunk\n");
  return path;
}

afterEach(() => {
  for (const path of workspaces) rmSync(path, { force: true, recursive: true });
  workspaces.clear();
});

function cli(
  cwd: string,
  args: string[],
  environment: NodeJS.ProcessEnv = process.env,
  linkHome: string = cwd,
): CliResult {
  const result = spawnSync(process.execPath, [CLI, ...args], {
    cwd,
    encoding: "utf8",
    env: {
      ...environment,
      GIT_CONFIG_GLOBAL: resolve(linkHome, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: linkHome,
    },
  });
  return { status: result.status, stderr: result.stderr, stdout: result.stdout };
}

function git(cwd: string, args: string[], linkHome: string): void {
  const result = spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_CONFIG_GLOBAL: resolve(linkHome, "gitconfig"),
      GIT_CONFIG_NOSYSTEM: "1",
      HOME: linkHome,
    },
  });
  if (result.status !== 0) throw new Error(result.stderr);
}

function commitTree(treePath: string, linkHome: string): void {
  git(treePath, ["add", "NODE.md", ".github/workflows/validate-context-tree.yml"], linkHome);
  git(
    treePath,
    ["-c", "user.name=Context Tree Test", "-c", "user.email=test@example.com", "commit", "-m", "Initialize tree"],
    linkHome,
  );
}

const INIT_ARGS = ["--repository", "acme/context", "--tree-path", "tree"];

describe("built CLI", () => {
  it("exposes the portable link and tree commands", () => {
    const help = cli(workspace(), ["--help"]);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("Portable tools for linking, resolving, scaffolding, reading, and validating");
    expect([...help.stdout.matchAll(/^ {2}([a-z][\w-]*)\s+/gmu)].map((match) => match[1]).sort()).toEqual([
      "diff",
      "init",
      "link",
      "policy",
      "read",
      "refresh",
      "resolve",
      "stage",
      "verify",
    ]);
    const version = cli(workspace(), ["--version"]);
    expect(version).toMatchObject({ status: 0, stderr: "", stdout: "0.1.2\n" });
  });

  it("runs init, policy, verify, and read with versioned JSON", () => {
    const cwd = workspace();
    const initialized = cli(cwd, ["init", ...INIT_ARGS]);
    expect(initialized.status).toBe(0);
    const scaffold = scaffoldTreeResultSchema.parse(JSON.parse(initialized.stdout));
    expect(scaffold.files).toEqual(["NODE.md", ".github/workflows/validate-context-tree.yml"]);
    expect(existsSync(resolve(cwd, "tree/.git"))).toBe(true);
    expect(readFileSync(resolve(cwd, "tree/.git/config"), "utf8")).toContain(
      "url = https://github.com/acme/context.git",
    );
    expect(existsSync(resolve(cwd, ".context-tree/connections.json"))).toBe(true);
    const workflowPath = resolve(cwd, "tree/.github/workflows/validate-context-tree.yml");
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, "utf8")).toContain('branches: ["trunk"]');
    expect(readFileSync(workflowPath, "utf8")).toContain("@first-tree-ai/context-tree@0.1.2 verify");

    const policy = cli(cwd, ["policy"]);
    expect(policy.status).toBe(0);
    contextTreePolicySchema.parse(JSON.parse(policy.stdout));

    const verification = cli(cwd, ["verify", "--tree-path", "tree"]);
    expect(verification.status).toBe(0);
    const verificationResult = verifyTreeReportSchema.parse(JSON.parse(verification.stdout));
    expect(verificationResult).toMatchObject({ ok: true, schemaVersion: 1 });
    const read = cli(cwd, ["read", "--tree-path", "tree"]);
    expect(read.status).toBe(0);
    const readResult = contextTreeReadResultSchema.parse(JSON.parse(read.stdout));
    expect(readResult.schemaVersion).toBe(1);
    expect(readResult.node.body).toContain("# context");
  });

  it("defaults init to cwd/REPO and derives its title from REPO", () => {
    const cwd = workspace();
    writeFileSync(resolve(cwd, "gitconfig"), "[init]\n\tdefaultBranch = Release_1\n");
    const initialized = cli(cwd, ["init", "--repository", "acme/my-context"]);
    expect(initialized.status).toBe(0);
    const scaffold = scaffoldTreeResultSchema.parse(JSON.parse(initialized.stdout));
    expect(scaffold.root).toBe(resolve(realpathSync(cwd), "my-context"));
    expect(readFileSync(resolve(cwd, "my-context/NODE.md"), "utf8")).toContain('title: "my-context"');
    expect(readFileSync(resolve(cwd, "my-context/NODE.md"), "utf8")).toContain("schemaVersion: 1");
    expect(existsSync(resolve(cwd, "my-context/SCOPE.md"))).toBe(false);
    expect(readFileSync(resolve(cwd, "my-context/.github/workflows/validate-context-tree.yml"), "utf8")).toContain(
      'branches: ["Release_1"]',
    );
  });

  it("requires an explicit GitHub identity and reports invalid trees", () => {
    const cwd = workspace();
    const missingIdentity = cli(cwd, ["init", "--tree-path", "tree"]);
    expectCliError(missingIdentity, "CONTEXT_TREE_FAILED");

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
    expectCliError(generic, "CONTEXT_TREE_FAILED");
  });

  it("preserves destination safety", () => {
    const cwd = workspace();
    const destination = resolve(cwd, "existing");
    mkdirSync(destination);
    writeFileSync(resolve(destination, "keep.txt"), "keep\n");

    const unsafe = cli(cwd, ["init", "--repository", "acme/context", "--tree-path", "existing"]);
    expect(expectCliError(unsafe, "CONTEXT_TREE_FAILED").error.message).toContain("non-empty directory");
    expect(readFileSync(resolve(destination, "keep.txt"), "utf8")).toBe("keep\n");
  });

  it("resolves Git projects by normalized origin and non-Git descendants by directory", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    git(project, ["init", "--quiet"], home);
    git(project, ["remote", "add", "origin", "git@github.com:acme/service.git"], home);
    mkdirSync(resolve(project, "packages/app"), { recursive: true });

    const initialized = cli(
      project,
      ["init", "--repository", "acme/context", "--tree-path", "../tree"],
      process.env,
      home,
    );
    expect(initialized.status).toBe(0);
    commitTree(resolve(home, "tree"), home);
    const resolvedGit = cli(resolve(project, "packages/app"), ["resolve"], process.env, home);
    expect(resolvedGit.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolvedGit.stdout)).link.tree).toMatchObject({
      repository: "acme/context",
    });
    const plain = resolve(home, "plain");
    mkdirSync(resolve(plain, "nested"), { recursive: true });
    const second = cli(
      plain,
      ["init", "--repository", "acme/plain-tree", "--tree-path", "../plain-tree"],
      process.env,
      home,
    );
    expect(second.status).toBe(0);
    commitTree(resolve(home, "plain-tree"), home);
    const resolvedPlain = cli(resolve(plain, "nested"), ["resolve"], process.env, home);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolvedPlain.stdout)).link.project).toMatchObject({
      kind: "directory",
      path: realpathSync(plain),
    });
  });

  it("links an arbitrary Git project without modifying or publishing the tree", () => {
    const home = workspace();
    const initializer = resolve(home, "initializer");
    const project = resolve(home, "project");
    mkdirSync(initializer);
    mkdirSync(project);
    expect(
      cli(initializer, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);
    git(project, ["init", "--quiet"], home);
    git(project, ["remote", "add", "origin", "https://gitlab.example/acme/service.git"], home);
    const beforeNode = readFileSync(resolve(tree, "NODE.md"), "utf8");

    const linked = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(tree)],
      process.env,
      home,
    );
    expect(linked.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(linked.stdout)).link.project).toEqual({
      kind: "git",
      origin: "https://gitlab.example/acme/service.git",
    });
    expect(readFileSync(resolve(tree, "NODE.md"), "utf8")).toBe(beforeNode);
    const status = spawnSync("git", ["-C", tree, "status", "--porcelain"], { encoding: "utf8" });
    expect(status.stdout).toBe("");
  });

  it("rejects unsafe Context Tree origins without exposing their values", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);
    const otherProject = resolve(home, "other-project");
    mkdirSync(otherProject);

    const rejectedOrigins = [
      "https://user@github.com/acme/context.git",
      "https://user:password-value@github.com/acme/context.git",
      "https://github.com/acme/context.git?token=query-value",
      "https://github.com/acme/context.git#fragment-value",
      "https://gitlab.com/acme/context.git",
    ];
    for (const origin of rejectedOrigins) {
      git(tree, ["remote", "set-url", "origin", origin], home);
      const result = cli(
        otherProject,
        ["link", "--project-path", otherProject, "--tree-path", realpathSync(tree)],
        process.env,
        home,
      );
      expectCliError(result, "CONTEXT_TREE_FAILED");
      expect(result.stdout).not.toContain(origin);
      for (const secret of ["password-value", "query-value", "fragment-value"]) {
        expect(result.stdout).not.toContain(secret);
      }
    }
  });

  it("reports missing, corrupt, duplicate, and stale links with strict envelopes", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expectCliError(cli(project, ["resolve"], process.env, home), "NO_LINK");

    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    commitTree(resolve(home, "tree"), home);
    const linkFile = resolve(home, ".context-tree/connections.json");
    const original = JSON.parse(readFileSync(linkFile, "utf8"));

    writeFileSync(linkFile, "{broken\n");
    expectCliError(cli(project, ["resolve"], process.env, home), "CORRUPT_LINK");
    for (const invalidPath of ["relative/tree", "/tmp/control\npath"]) {
      writeFileSync(
        linkFile,
        `${JSON.stringify({
          ...original,
          links: [{ ...original.links[0], tree: { ...original.links[0].tree, path: invalidPath } }],
        })}\n`,
      );
      expectCliError(cli(project, ["resolve"], process.env, home), "CORRUPT_LINK");
    }
    writeFileSync(linkFile, `${JSON.stringify({ ...original, links: [...original.links, ...original.links] })}\n`);
    expectCliError(cli(project, ["resolve"], process.env, home), "AMBIGUOUS_LINK");
    writeFileSync(linkFile, `${JSON.stringify(original)}\n`);

    renameSync(resolve(home, "tree"), resolve(home, "moved-tree"));
    expectCliError(cli(project, ["resolve"], process.env, home), "STALE_LINK");
  });

  it("rejects invalid roots, dirty checkouts, and mismatched stored origins during resolution", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    const rootNode = readFileSync(resolve(tree, "NODE.md"), "utf8");
    commitTree(tree, home);

    writeFileSync(resolve(tree, "NODE.md"), '---\ntitle: "Invalid"\n---\n\n# Invalid\n');
    git(tree, ["add", "NODE.md"], home);
    git(
      tree,
      ["-c", "user.name=Context Tree Test", "-c", "user.email=test@example.com", "commit", "-m", "Invalid root"],
      home,
    );
    expectCliError(cli(project, ["resolve"], process.env, home), "STALE_LINK");

    writeFileSync(resolve(tree, "NODE.md"), rootNode);
    git(tree, ["add", "NODE.md"], home);
    git(
      tree,
      ["-c", "user.name=Context Tree Test", "-c", "user.email=test@example.com", "commit", "-m", "Restore root"],
      home,
    );
    writeFileSync(resolve(tree, "dirty.txt"), "dirty\n");
    expectCliError(cli(project, ["resolve"], process.env, home), "STALE_LINK");
    rmSync(resolve(tree, "dirty.txt"));

    git(tree, ["remote", "set-url", "origin", "https://github.com/acme/other-context.git"], home);
    const mismatch = expectCliError(cli(project, ["resolve"], process.env, home), "STALE_LINK");
    expect(mismatch.error.message).toContain("different Context Tree repository");
  });

  it("allows only idempotent or stale-path relinks to the same repository", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);

    const samePath = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(tree)],
      process.env,
      home,
    );
    expect(samePath.status).toBe(0);
    const sameResult = contextTreeLinkResultSchema.parse(JSON.parse(samePath.stdout));
    expect(sameResult.link.tree.path).toBe(realpathSync(tree));

    git(home, ["clone", "--quiet", tree, "second-tree"], home);
    const secondTree = resolve(home, "second-tree");
    git(secondTree, ["remote", "set-url", "origin", "https://github.com/acme/context.git"], home);
    const secondLive = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(secondTree)],
      process.env,
      home,
    );
    expect(expectCliError(secondLive, "CONTEXT_TREE_FAILED").error.message).toContain("still live");

    writeFileSync(resolve(tree, "dirty.txt"), "dirty\n");
    const dirtyStillLive = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(secondTree)],
      process.env,
      home,
    );
    expect(expectCliError(dirtyStillLive, "CONTEXT_TREE_FAILED").error.message).toContain("still live");
    rmSync(resolve(tree, "dirty.txt"));

    const movedTree = resolve(home, "moved-tree");
    renameSync(tree, movedTree);
    const moved = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(movedTree)],
      process.env,
      home,
    );
    expect(moved.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(moved.stdout)).link.tree.path).toBe(realpathSync(movedTree));

    const linkFile = resolve(home, ".context-tree/connections.json");
    const stored = JSON.parse(readFileSync(linkFile, "utf8"));
    const invalidOldPath = resolve(home, "not-a-checkout");
    mkdirSync(invalidOldPath);
    stored.links[0].tree.path = invalidOldPath;
    writeFileSync(linkFile, `${JSON.stringify(stored)}\n`);
    const repaired = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(secondTree)],
      process.env,
      home,
    );
    expect(repaired.status).toBe(0);

    renameSync(secondTree, resolve(home, "stale-second-tree"));
    git(movedTree, ["remote", "set-url", "origin", "https://github.com/acme/different.git"], home);
    const different = cli(
      project,
      ["link", "--project-path", project, "--tree-path", realpathSync(movedTree)],
      process.env,
      home,
    );
    expect(expectCliError(different, "CONTEXT_TREE_FAILED").error.message).toContain(
      "different Context Tree repository",
    );
  });

  it("resolves a safe root candidate without scanning semantic tree content", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);
    mkdirSync(resolve(tree, "broken"));
    writeFileSync(resolve(tree, "broken/NODE.md"), "---\ntitle: []\n---\n\n# Broken\n");
    git(tree, ["add", "broken/NODE.md"], home);
    git(
      tree,
      ["-c", "user.name=Context Tree Test", "-c", "user.email=test@example.com", "commit", "-m", "Invalid child"],
      home,
    );

    const resolved = cli(project, ["resolve"], process.env, home);
    expect(resolved.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolved.stdout)).link.tree.path).toBe(realpathSync(tree));
    const verified = cli(project, ["verify", "--tree-path", tree], process.env, home);
    expect(verified.status).toBe(1);
    expect(verifyTreeReportSchema.parse(JSON.parse(verified.stdout)).ok).toBe(false);
  });

  it("inspects the pending diff of a worktree through the CLI", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);
    writeFileSync(resolve(tree, "systems.md"), "---\ntitle: systems\n---\n\n# Systems\n");
    git(tree, ["add", "NODE.md", "systems.md"], home);
    git(
      tree,
      ["-c", "user.name=Context Tree Test", "-c", "user.email=test@example.com", "commit", "-m", "Add leaf"],
      home,
    );
    writeFileSync(resolve(tree, "systems.md"), "---\ntitle: systems\n---\n\n# Systems\n\nUpdated evidence.\n");

    const diff = cli(home, ["diff", realpathSync(tree)]);
    expect(diff.status).toBe(0);
    const result = JSON.parse(diff.stdout);
    expect(result.files).toEqual([{ path: "systems.md", status: "modified" }]);
    expect(result.patch).toContain("Updated evidence");
    expect(result.base).toBe("HEAD");
  });

  it("requires a link for refresh and stage on unlinked projects", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expectCliError(cli(project, ["refresh"], process.env, home), "NO_LINK");
    expectCliError(cli(project, ["stage"], process.env, home), "NO_LINK");
  });

  it("stages a linked tree when a successful fetch has empty stdout", () => {
    const home = workspace();
    const project = resolve(home, "project");
    const remote = resolve(home, "context.git");
    mkdirSync(project);
    git(home, ["init", "--bare", remote], home);
    expect(
      cli(project, ["init", "--repository", "acme/context", "--tree-path", "../tree"], process.env, home).status,
    ).toBe(0);
    const tree = resolve(home, "tree");
    commitTree(tree, home);
    git(tree, ["push", remote, "trunk"], home);
    const gitExecutable = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = resolve(home, "bin");
    const fakeGit = resolve(fakeBin, "git");
    mkdirSync(fakeBin);
    writeFileSync(
      fakeGit,
      `#!/bin/sh\nif [ "$3" = "fetch" ] && [ "$4" = "origin" ]; then exec "${gitExecutable}" -C "$2" fetch "${remote}" "$5:refs/remotes/origin/$5"; fi\nif [ "$3" = "ls-remote" ] && [ "$4" = "--symref" ] && [ "$5" = "origin" ]; then exec "${gitExecutable}" -C "$2" ls-remote --symref "${remote}" HEAD; fi\nexec "${gitExecutable}" "$@"\n`,
    );
    chmodSync(fakeGit, 0o755);

    const staged = cli(project, ["stage"], { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` }, home);
    expect(staged.status, staged.stdout).toBe(0);
    const result = contextTreeStageResultSchema.parse(JSON.parse(staged.stdout));
    workspaces.add(result.worktreePath);
    expect(result).toMatchObject({
      defaultBranch: "trunk",
      schemaVersion: 1,
    });
    expect(result.link.tree.path).toBe(realpathSync(tree));
    expect(existsSync(result.worktreePath)).toBe(true);
  });
});
