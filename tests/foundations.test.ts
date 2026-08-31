import { lstatSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CommandError,
  defaultRunner,
  gh,
  git,
  optionalGh,
  optionalGit,
  sanitizeCommandOutput,
} from "../src/core/internal/git.js";
import { canonicalProjectRoot } from "../src/core/internal/project.js";
import { resolveTreeState, validateStoredTreeState } from "../src/core/internal/tree-state.js";
import { scaffoldTree } from "../src/core/scaffold.js";

const temporaryRoots = new Set<string>();
const originalGitConfigGlobal = process.env.GIT_CONFIG_GLOBAL;
const originalGitConfigNoSystem = process.env.GIT_CONFIG_NOSYSTEM;

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-foundations-"));
  temporaryRoots.add(root);
  return root;
}

afterEach(() => {
  if (originGitConfigGlobalWasUnset()) delete process.env.GIT_CONFIG_GLOBAL;
  else process.env.GIT_CONFIG_GLOBAL = originalGitConfigGlobal;
  if (originalGitConfigNoSystem === undefined) delete process.env.GIT_CONFIG_NOSYSTEM;
  else process.env.GIT_CONFIG_NOSYSTEM = originalGitConfigNoSystem;
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

function originGitConfigGlobalWasUnset(): boolean {
  return originalGitConfigGlobal === undefined;
}

beforeEach(() => {
  const config = join(tempRoot(), "gitconfig");
  writeFileSync(config, "[init]\n\tdefaultBranch = trunk\n");
  process.env.GIT_CONFIG_GLOBAL = config;
  process.env.GIT_CONFIG_NOSYSTEM = "1";
});

function run(cwd: string, args: string[]): void {
  const result = defaultRunner("git", ["-C", cwd, ...args]);
  if (result.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr}`);
}

function validTree(): string {
  const root = join(tempRoot(), "tree");
  scaffoldTree({ path: root, name: "context" });
  return root;
}

describe("Git command runner", () => {
  it("returns trimmed stdout for successful commands", () => {
    const root = tempRoot();
    run(root, ["init", "--quiet"]);
    expect(git(root, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  });

  it("throws a CommandError carrying the sanitized stderr detail", () => {
    const root = tempRoot();
    expect(() => git(root, ["rev-parse", "HEAD"], { message: "Resolve HEAD failed." })).toThrow(CommandError);
    try {
      git(root, ["rev-parse", "HEAD"], { message: "Resolve HEAD failed." });
    } catch (error) {
      expect(error).toBeInstanceOf(CommandError);
      const commandError = error as CommandError;
      expect(commandError.command).toBe("git");
      expect(commandError.status).not.toBe(0);
      expect(commandError.message).toContain("Resolve HEAD failed.");
      expect(commandError.message).not.toContain("git rev-parse");
    }
  });

  it("returns undefined instead of throwing for optional Git commands", () => {
    const root = tempRoot();
    expect(optionalGit(root, ["remote", "get-url", "origin"])).toBeUndefined();
    run(root, ["init", "--quiet"]);
    expect(optionalGit(root, ["rev-parse", "--is-inside-work-tree"])).toBe("true");
  });

  it("supports the GitHub CLI through the same runner contract", () => {
    const failingRunner = () => ({ status: 1, stdout: "", stderr: "gh not authenticated" });
    expect(() => gh(["api", "user"], { runner: failingRunner, message: "Authentication failed." })).toThrow(
      "Authentication failed.: gh not authenticated",
    );
    expect(optionalGh(["api", "user"], failingRunner)).toBeUndefined();
    expect(gh(["api", "user"], { runner: () => ({ status: 0, stdout: "octocat\n", stderr: "" }) })).toBe("octocat");
  });

  it("supports injectable runners for hermetic tests", () => {
    const runner = () => ({ status: 0, stdout: "  value  \n", stderr: "" });
    expect(git("/unused", ["anything"], { runner })).toBe("value");
  });

  it("redacts credentials and tokens from surfaced command failures", () => {
    const secret = "ghp_abcdefghijklmnopqrstuvwxyz123456";
    const runner = () => ({
      status: 1,
      stdout: "",
      stderr: `failed https://user:pass@github.com/acme/tree.git Authorization: Bearer ${secret}`,
    });
    expect(() => git("/unused", ["fetch"], { runner })).toThrow(/<redacted>/u);
    expect(() => git("/unused", ["fetch"], { runner })).not.toThrow(secret);
    expect(sanitizeCommandOutput(secret)).toBe("<redacted>");
  });
});

describe("canonical project roots", () => {
  it("maps a Git project and its nested working directories to the real repository root", () => {
    const root = tempRoot();
    run(root, ["init", "--quiet"]);
    const nested = join(root, "deep", "nested");
    mkdirSync(nested, { recursive: true });
    expect(canonicalProjectRoot(root)).toBe(realpathSync(root));
    expect(canonicalProjectRoot(nested)).toBe(realpathSync(root));
  });

  it("returns the real directory for non-Git projects", () => {
    const root = tempRoot();
    expect(canonicalProjectRoot(root)).toBe(realpathSync(root));
  });

  it("rejects missing directories and symlinked project paths", () => {
    const root = tempRoot();
    const target = join(root, "target");
    mkdirSync(target);
    const link = join(root, "link");
    symlinkSync(target, link, "dir");
    expect(() => canonicalProjectRoot(join(root, "missing"))).toThrow();
    expect(() => canonicalProjectRoot(link)).toThrow();
    expect(() => canonicalProjectRoot(target)).not.toThrow();
  });

  it("treats a Git worktree as an independent checkout with its own canonical root", () => {
    const repo = tempRoot();
    run(repo, ["init", "--quiet"]);
    writeFileSync(join(repo, "file.txt"), "content\n");
    run(repo, ["add", "file.txt"]);
    run(repo, ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "init"]);
    const worktree = join(tempRoot(), "worktree");
    run(repo, ["worktree", "add", "--quiet", worktree]);
    const repoRoot = canonicalProjectRoot(repo);
    const worktreeRoot = canonicalProjectRoot(worktree);
    expect(worktreeRoot).toBe(realpathSync(worktree));
    expect(worktreeRoot).not.toBe(repoRoot);
  });
});

describe("tree-state resolution", () => {
  it("uses the injected runner for exact Git-root and cleanliness validation", () => {
    const root = validTree();
    rmSync(join(root, ".git"), { force: true, recursive: true });
    const calls: string[][] = [];
    const runner = (command: string, args: string[]) => {
      calls.push([command, ...args]);
      if (args.includes("--show-toplevel")) return { status: 0, stdout: `${realpathSync(root)}\n`, stderr: "" };
      if (args.includes("status")) return { status: 0, stdout: "", stderr: "" };
      return { status: 1, stdout: "", stderr: "unexpected command" };
    };

    expect(resolveTreeState(root, runner)).toEqual({ kind: "local", path: realpathSync(root) });
    expect(calls).toEqual([
      ["git", "-C", realpathSync(root), "rev-parse", "--show-toplevel"],
      ["git", "-C", realpathSync(root), "status", "--porcelain", "--untracked-files=all"],
    ]);
  });

  it("resolves a local-only tree without an origin", () => {
    const root = validTree();
    const state = resolveTreeState(root);
    expect(state).toEqual({ kind: "local", path: realpathSync(root) });
  });

  it("keeps explicitly local state local even when an origin exists", () => {
    const root = validTree();
    run(root, ["remote", "add", "origin", "git@github.com:acme/Context.git"]);
    const state = resolveTreeState(root);
    expect(state).toEqual({ kind: "local", path: realpathSync(root) });
  });

  it("keeps stored GitHub state GitHub even when its origin is absent", () => {
    const root = validTree();
    expect(validateStoredTreeState({ kind: "github", path: root, repository: "acme/context" })).toEqual({
      kind: "github",
      path: realpathSync(root),
      repository: "acme/context",
    });
  });

  it("rejects dirty trees, non-root paths, missing directories, and symlinked paths", () => {
    const root = validTree();
    writeFileSync(join(root, "NODE.md"), '---\nschemaVersion: 1\ntitle: "Edited"\n---\n\n# Edited\n');
    expect(() => resolveTreeState(root)).toThrow("must be clean");

    const cleanRoot = validTree();
    expect(() => resolveTreeState(join(cleanRoot, ".github"))).toThrow("real Git root");
    expect(() => resolveTreeState(join(cleanRoot, "missing"))).toThrow();
    const link = join(tempRoot(), "link");
    symlinkSync(cleanRoot, link, "dir");
    expect(() => resolveTreeState(link)).toThrow();
  });

  it("rejects invalid trees even when they are clean", () => {
    const root = validTree();
    writeFileSync(join(root, "NODE.md"), '---\nschemaVersion: 1\ntitle: "Broken"\n---\n');
    run(root, ["add", "NODE.md"]);
    run(root, ["-c", "user.name=T", "-c", "user.email=t@example.test", "commit", "--quiet", "-m", "break"]);
    expect(() => resolveTreeState(root)).toThrow();
  });

  it("does not infer or mutate local state from a credential-bearing origin", () => {
    const root = validTree();
    run(root, ["remote", "add", "origin", "https://token@github.com/acme/context.git"]);
    expect(resolveTreeState(root)).toEqual({ kind: "local", path: realpathSync(root) });
  });

  it("rejects an ancestor symlink", () => {
    const parent = tempRoot();
    const root = validTree();
    const alias = join(parent, "alias");
    symlinkSync(root, alias, "dir");
    expect(() => resolveTreeState(alias)).toThrow(/symlink component/u);
  });

  it("exposes path containment for callers validating derived destinations", () => {
    const root = validTree();
    const state = resolveTreeState(root);
    if (state.kind !== "local") throw new Error("expected a local tree");
    expect(lstatSync(state.path).isDirectory()).toBe(true);
    expect(resolve(state.path)).toBe(state.path);
  });
});
