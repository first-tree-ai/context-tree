import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
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
  contextTreePushResultSchema,
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

const INIT_ARGS = ["context", "--tree-path", "tree"];

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
      "push",
      "read",
      "refresh",
      "resolve",
      "stage",
      "verify",
    ]);
    const version = cli(workspace(), ["--version"]);
    expect(version).toMatchObject({ status: 0, stderr: "", stdout: "0.1.5\n" });
  });

  it("runs init, policy, verify, and read with versioned JSON", () => {
    const cwd = workspace();
    const initialized = cli(cwd, ["init", ...INIT_ARGS]);
    expect(initialized.status).toBe(0);
    const scaffold = scaffoldTreeResultSchema.parse(JSON.parse(initialized.stdout));
    expect(scaffold.files).toEqual([
      "NODE.md",
      "AGENTS.md",
      "CLAUDE.md",
      ".github/workflows/validate-context-tree.yml",
    ]);
    const agents = readFileSync(resolve(cwd, "tree/AGENTS.md"), "utf8");
    expect(agents).toContain("This repository is a Context Tree: durable shared memory for agents.");
    expect(agents).toContain("Root `NODE.md` contains repository-wide context");
    expect(agents).toContain("Would this change how a future agent acts?");
    expect(lstatSync(resolve(cwd, "tree/CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(resolve(cwd, "tree/CLAUDE.md"))).toBe("AGENTS.md");
    expect(existsSync(resolve(cwd, "tree/.git"))).toBe(true);
    expect(readFileSync(resolve(cwd, "tree/.git/config"), "utf8")).not.toContain("remote");
    expect(existsSync(resolve(cwd, ".context-tree/connections.json"))).toBe(true);
    const workflowPath = resolve(cwd, "tree/.github/workflows/validate-context-tree.yml");
    expect(existsSync(workflowPath)).toBe(true);
    expect(readFileSync(workflowPath, "utf8")).toContain('branches: ["trunk"]');
    expect(readFileSync(workflowPath, "utf8")).toContain("@first-tree-ai/context-tree@0.1.5 verify");

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
    const initialized = cli(cwd, ["init", "my-context"]);
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

  it("requires a safe tree name and reports invalid trees", () => {
    const cwd = workspace();
    const invalidName = cli(cwd, ["init", "acme/context", "--tree-path", "tree"]);
    expectCliError(invalidName, "CONTEXT_TREE_FAILED");

    expect(cli(cwd, ["init", ...INIT_ARGS]).status).toBe(0);
    rmSync(resolve(cwd, "tree/NODE.md"));
    const invalid = cli(cwd, ["verify", "--tree-path", "tree"]);
    expect(invalid.status).toBe(1);
    const invalidResult = verifyTreeReportSchema.parse(JSON.parse(invalid.stdout));
    expect(invalidResult).toMatchObject({ ok: false, schemaVersion: 1 });

    const generic = cli(cwd, ["init", "context.git", "--tree-path", "other"]);
    expectCliError(generic, "CONTEXT_TREE_FAILED");
  });

  it("preserves destination safety", () => {
    const cwd = workspace();
    const destination = resolve(cwd, "existing");
    mkdirSync(destination);
    writeFileSync(resolve(destination, "keep.txt"), "keep\n");

    const unsafe = cli(cwd, ["init", "context", "--tree-path", "existing"]);
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

    const initialized = cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home);
    expect(initialized.status).toBe(0);
    const resolvedGit = cli(resolve(project, "packages/app"), ["resolve"], process.env, home);
    expect(resolvedGit.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolvedGit.stdout)).link.tree).toMatchObject({
      path: realpathSync(resolve(home, "tree")),
    });
    const plain = resolve(home, "plain");
    mkdirSync(resolve(plain, "nested"), { recursive: true });
    const second = cli(plain, ["init", "plain-tree", "--tree-path", "../plain-tree"], process.env, home);
    expect(second.status).toBe(0);
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
    expect(cli(initializer, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
    const otherProject = resolve(home, "other-project");
    mkdirSync(otherProject);

    const rejectedOrigins = [
      "https://user@github.com/acme/context.git",
      "https://user:password-value@github.com/acme/context.git",
      "https://github.com/acme/context.git?token=query-value",
      "https://github.com/acme/context.git#fragment-value",
      "https://gitlab.com/acme/context.git",
    ];
    git(tree, ["remote", "add", "origin", "https://github.com/acme/context.git"], home);
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

    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
    const rootNode = readFileSync(resolve(tree, "NODE.md"), "utf8");
    git(tree, ["remote", "add", "origin", "https://github.com/acme/context.git"], home);
    expect(cli(project, ["resolve"], process.env, home).status).toBe(0);

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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
    git(tree, ["remote", "add", "origin", "https://github.com/acme/context.git"], home);
    expect(cli(project, ["resolve"], process.env, home).status).toBe(0);

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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
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
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");
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

  it("supports local-only trees with staging from HEAD and NO_REMOTE refresh", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");

    const stored = JSON.parse(readFileSync(resolve(home, ".context-tree/connections.json"), "utf8"));
    expect(stored.links[0].tree).toEqual({ path: realpathSync(tree) });

    expectCliError(cli(project, ["refresh"], process.env, home), "NO_REMOTE");

    const staged = cli(project, ["stage"], process.env, home);
    expect(staged.status, staged.stdout).toBe(0);
    const stageResult = contextTreeStageResultSchema.parse(JSON.parse(staged.stdout));
    workspaces.add(stageResult.worktreePath);
    expect(stageResult).toMatchObject({
      baseSha: expect.stringMatching(/^[0-9a-f]{40}$/u),
      defaultBranch: "trunk",
    });
    expect(stageResult.link.tree).toEqual({ path: realpathSync(tree) });
  });

  it("backfills the stored repository identity after an origin appears", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const tree = resolve(home, "tree");

    git(tree, ["remote", "add", "origin", "https://github.com/acme/context.git"], home);
    const resolved = cli(project, ["resolve"], process.env, home);
    expect(resolved.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolved.stdout)).link.tree).toEqual({
      path: realpathSync(tree),
      repository: "acme/context",
    });
    const stored = JSON.parse(readFileSync(resolve(home, ".context-tree/connections.json"), "utf8"));
    expect(stored.links[0].tree.repository).toBe("acme/context");
  });

  it("pushes a committed local tree to a new private repository created through gh", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const bare = resolve(home, "context.git");
    const gitExecutable = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
    const fakeBin = resolve(home, "bin");
    mkdirSync(fakeBin);
    const fakeGh = resolve(fakeBin, "gh");
    writeFileSync(
      fakeGh,
      `#!/bin/sh\nif [ "$1" = "repo" ] && [ "$2" = "create" ]; then git init --quiet --bare "${bare}"; exit 0; fi\nexit 0\n`,
    );
    chmodSync(fakeGh, 0o755);
    const fakeGit = resolve(fakeBin, "git");
    writeFileSync(
      fakeGit,
      `#!/bin/sh\ncase "$*" in\n  *" remote get-url "*)\n    args=""\n    for a in "$@"; do args="$args '$a'"; done\n    if eval "'${gitExecutable}' $args" >/dev/null 2>&1; then\n      echo "https://github.com/acme/context.git"\n      exit 0\n    fi\n    exit 1\n    ;;\nesac\nargs=""\nfor a in "$@"; do\n  case "$a" in\n    https://github.com/acme/context.git) a="${bare}" ;;\n  esac\n  args="$args '$a'"\ndone\neval "exec '${gitExecutable}' $args"\n`,
    );
    chmodSync(fakeGit, 0o755);
    const pushPath = { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` };

    const pushed = cli(project, ["push", "acme/context", "--tree-path", "../tree"], pushPath, home);
    expect(pushed.status, pushed.stdout).toBe(0);
    const result = contextTreePushResultSchema.parse(JSON.parse(pushed.stdout));
    expect(result).toMatchObject({
      branch: "trunk",
      defaultBranch: "trunk",
      remote: { name: "origin", repository: "acme/context", url: "https://github.com/acme/context.git" },
      schemaVersion: 1,
      uncommittedFiles: 0,
    });
    expect(spawnSync("git", ["-C", bare, "rev-parse", "refs/heads/trunk"], { encoding: "utf8" }).status).toBe(0);

    const resolved = cli(project, ["resolve"], pushPath, home);
    expect(resolved.status).toBe(0);
    expect(contextTreeLinkResultSchema.parse(JSON.parse(resolved.stdout)).link.tree).toMatchObject({
      repository: "acme/context",
    });
  });

  it("fails cleanly when GitHub repository creation fails", () => {
    const home = workspace();
    const project = resolve(home, "project");
    mkdirSync(project);
    expect(cli(project, ["init", "context", "--tree-path", "../tree"], process.env, home).status).toBe(0);
    const fakeBin = resolve(home, "bin");
    mkdirSync(fakeBin);
    const fakeGh = resolve(fakeBin, "gh");
    writeFileSync(fakeGh, '#!/bin/sh\necho "name already exists on this account" >&2\nexit 1\n');
    chmodSync(fakeGh, 0o755);

    const pushed = cli(
      project,
      ["push", "acme/context", "--tree-path", "../tree"],
      { ...process.env, PATH: `${fakeBin}:${process.env.PATH ?? ""}` },
      home,
    );
    expect(expectCliError(pushed, "CONTEXT_TREE_FAILED").error.message).toContain("already exists");
  });
});
