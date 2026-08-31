import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

const CLI = resolve(import.meta.dirname, "../dist/cli/index.mjs");
const HOOK = resolve(import.meta.dirname, "../hooks/session-start.mjs");
const roots = new Set<string>();

function workspace(): string {
  const root = mkdtempSync(resolve(tmpdir(), "context-tree-hook-"));
  roots.add(root);
  writeFileSync(resolve(root, "gitconfig"), "[init]\n\tdefaultBranch = trunk\n");
  return root;
}

function environment(root: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_PLUGIN_ROOT: resolve(import.meta.dirname, ".."),
    GIT_CONFIG_GLOBAL: resolve(root, "gitconfig"),
    GIT_CONFIG_NOSYSTEM: "1",
    HOME: root,
  };
}

type ProcessResult = { status: number | null; stdout: string };

function run(home: string, cwd: string, command: string, args: string[], input?: string): ProcessResult {
  const result = spawnSync(command, args, { cwd, encoding: "utf8", env: environment(home), input });
  return { status: result.status, stdout: typeof result.stdout === "string" ? result.stdout : "" };
}

function initialize(root: string): string {
  const project = resolve(root, "project");
  mkdirSync(project);
  expect(
    run(root, project, process.execPath, [CLI, "init", "--repository", "acme/context", "--tree-path", "../tree"])
      .status,
  ).toBe(0);
  const tree = resolve(root, "tree");
  expect(run(root, tree, "git", ["add", "."]).status).toBe(0);
  expect(
    run(root, tree, "git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "init"])
      .status,
  ).toBe(0);
  return project;
}

function hook(root: string, cwd: string, event = "SessionStart"): ProcessResult {
  return run(root, root, process.execPath, [HOOK], JSON.stringify({ cwd, hook_event_name: event }));
}

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe("lifecycle context injection", () => {
  it("is silent without a link and injects minimal context for sessions and subagents", () => {
    const root = workspace();
    const unlinked = resolve(root, "unlinked");
    mkdirSync(unlinked);
    expect(hook(root, unlinked).stdout).toBe("");
    expect(hook(root, unlinked, "UnsupportedEvent").stdout).toBe("");

    const project = initialize(root);
    for (const event of ["SessionStart", "SubagentStart"]) {
      const result = hook(root, project, event);
      expect(result.status).toBe(0);
      expect(JSON.parse(result.stdout)).toMatchObject({
        hookSpecificOutput: {
          additionalContext: expect.stringContaining("Context Tree acme/context is linked"),
          hookEventName: event,
        },
      });
    }
  });

  it("warns when the packaged CLI is absent and never invokes a PATH-installed CLI", () => {
    const root = workspace();
    const fakePlugin = resolve(root, "plugin-without-cli");
    const fakeBin = resolve(root, "bin");
    const marker = resolve(root, "path-cli-was-invoked");
    mkdirSync(fakePlugin);
    mkdirSync(fakeBin);
    const fakeCli = resolve(fakeBin, "context-tree");
    writeFileSync(fakeCli, `#!/bin/sh\ntouch "${marker}"\n`);
    chmodSync(fakeCli, 0o755);
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: root,
      encoding: "utf8",
      env: {
        ...environment(root),
        CLAUDE_PLUGIN_ROOT: fakePlugin,
        PATH: fakeBin,
      },
      input: JSON.stringify({ cwd: root, hook_event_name: "SessionStart" }),
    });
    expect(result.status).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      systemMessage: "Context Tree setup warning: packaged CLI is unavailable.",
    });
    expect(existsSync(marker)).toBe(false);
  });

  it("warns without repairing stale state and shares one script across host manifests", () => {
    const root = workspace();
    const project = initialize(root);
    renameSync(resolve(root, "tree"), resolve(root, "moved"));
    expect(JSON.parse(hook(root, project).stdout)).toMatchObject({
      systemMessage: expect.stringContaining("no longer a valid clean candidate"),
    });
    expect(readFileSync(resolve(import.meta.dirname, "../hooks/hooks.json"), "utf8")).toContain(
      ["$", "{CLAUDE_PLUGIN_ROOT}/hooks/session-start.mjs"].join(""),
    );
    expect(readFileSync(resolve(import.meta.dirname, "../.codex-plugin/plugin.json"), "utf8")).toContain(
      '"name": "context-tree"',
    );
    expect(readFileSync(resolve(import.meta.dirname, "../.claude-plugin/plugin.json"), "utf8")).toContain(
      '"name": "context-tree"',
    );
  });
});
