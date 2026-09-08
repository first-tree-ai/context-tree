import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { runContextTreeCli } from "../src/cli/api.js";
import { agentArguments, runAgent } from "../src/core/cleanup/agent.js";
import {
  cleanupStatus,
  parseCleanupInterval,
  recordCleanupActivity,
  removeCleanup,
  runCleanup,
  scheduleCleanup,
} from "../src/core/cleanup/index.js";
import { type CleanupScheduler, nativeScheduler } from "../src/core/cleanup/scheduler.js";
import { atomicState, loadSchedule, readState, statePath } from "../src/core/cleanup/store.js";
import { connectProject } from "../src/core/connections.js";
import { createProject } from "../src/core/create.js";
import { ContextTreeError } from "../src/core/internal/errors.js";
import { CLI_ERROR_CODES, type CleanupSchedule } from "../src/schemas.js";

let home: string;
let project: string;
let tree: string;
let scheduler: CleanupScheduler;
let config: CleanupSchedule;
const worktrees = new Set<string>();
beforeEach(() => {
  home = realpathSync(mkdtempSync(join(tmpdir(), "context-tree-cleanup-test-")));
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  writeFileSync(
    join(home, "gitconfig"),
    "[user]\nname = Test\nemail = test@example.test\n[init]\ndefaultBranch = main\n",
  );
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o700 });
  writeFileSync(join(bin, "claude"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH}`);
  project = join(home, "project");
  mkdirSync(project);
  tree = createProject(project).treePath;
  let registered = false;
  scheduler = {
    status: () => ({ registered, running: false }),
    install: () => {
      registered = true;
    },
    remove: () => {
      registered = false;
    },
  };
  const result = scheduleCleanup({ projectPath: project, agent: "codex" }, scheduler);
  if (!result.schedule) throw new Error("missing schedule");
  config = result.schedule;
});
afterEach(() => {
  for (const path of worktrees) rmSync(path, { recursive: true, force: true });
  worktrees.clear();
  vi.unstubAllEnvs();
  rmSync(home, { recursive: true, force: true });
  process.exitCode = 0;
});
function remember(path: string): void {
  worktrees.add(path);
}

describe("cleanup scheduling and activity", () => {
  it("updates one tree across projects and removes idempotently", () => {
    const second = join(home, "second");
    mkdirSync(second);
    connectProject({ projectPath: second, treePath: tree });
    const updated = scheduleCleanup(
      { projectPath: second, agent: "claude", every: "30m", model: "explicit" },
      scheduler,
    );
    expect(updated.schedule?.id).toBe(config.id);
    expect(updated.schedule?.everyMinutes).toBe(30);
    expect(updated.schedule?.model).toBe("explicit");
    expect(updated.latest).toBeNull();
    expect(cleanupStatus(project, scheduler).registered).toBe(true);
    expect(removeCleanup(project, scheduler).registered).toBe(false);
    expect(removeCleanup(project, scheduler).registered).toBe(false);
  });
  it("validates cadence", () => {
    expect(parseCleanupInterval()).toBe(60);
    expect(parseCleanupInterval("2d")).toBe(2880);
    for (const value of ["0m", "1.5h", "20s", "-1m", "999999999h"]) expect(() => parseCleanupInterval(value)).toThrow();
  });
  it("records successful foreground CLI reads, but not background activity or status", async () => {
    atomicState(statePath(config.id, "activity"), 1);
    cleanupStatus(project, scheduler);
    expect(readState(statePath(config.id, "activity"))).toBe(1);
    const stdout = vi.fn();
    expect(
      await runContextTreeCli(["node", "context-tree", "read", "--tree-path", tree, "--json"], {
        cwd: () => project,
        stdout,
      }),
    ).toBe(0);
    expect(readState(statePath(config.id, "activity"))).not.toBe(1);
    atomicState(statePath(config.id, "activity"), 1);
    vi.stubEnv("CONTEXT_TREE_CLEANUP", "1");
    recordCleanupActivity({ projectPath: project });
    expect(readState(statePath(config.id, "activity"))).toBe(1);
  });
  it("fails closed on symlinked state and activity errors never break CLI use", () => {
    const path = statePath(config.id, "activity");
    rmSync(path);
    symlinkSync(join(home, "gitconfig"), path);
    expect(() => cleanupStatus(project, scheduler)).toThrow();
    expect(() => recordCleanupActivity({ projectPath: project })).not.toThrow();
  });
});

describe("cleanup lifecycle", () => {
  it("skips inactive or missing activity before sync or model work", async () => {
    const sync = vi.fn();
    const agent = vi.fn();
    atomicState(statePath(config.id, "activity"), 1);
    expect((await runCleanup(project, undefined, { sync, agent })).outcome).toBe("inactive");
    rmSync(statePath(config.id, "activity"));
    expect((await runCleanup(project, undefined, { sync, agent })).outcome).toBe("inactive");
    expect(sync).not.toHaveBeenCalled();
    expect(agent).not.toHaveBeenCalled();
  });
  it("records no-op inspection then skips unchanged snapshots without model or activity refresh", async () => {
    const oldActivity = readState(statePath(config.id, "activity"));
    const agent = vi.fn(async (_config, path: string) => {
      remember(path);
    });
    expect((await runCleanup(project, undefined, { agent })).outcome).toBe("noop");
    expect((await runCleanup(project, undefined, { agent })).outcome).toBe("unchanged");
    expect(agent).toHaveBeenCalledTimes(1);
    expect(readState(statePath(config.id, "activity"))).toBe(oldActivity);
  });
  it("publishes one valid edit through the real lifecycle", async () => {
    const result = await runCleanup(project, undefined, {
      agent: async (_config, path) => {
        remember(path);
        const file = join(path, "NODE.md");
        writeFileSync(file, `${readFileSync(file, "utf8")}\nA durable constraint.\n`);
      },
    });
    expect(result.outcome).toBe("published");
    expect(readFileSync(join(tree, "NODE.md"), "utf8")).toContain("A durable constraint.");
    expect(readState(statePath(config.id, "success"))).toBe(result.sha);
  });
  for (const failure of ["infra", "symlink", "invalid", "auth", "staged"]) {
    it(`preserves worktree and checkpoint after ${failure}`, async () => {
      const result = await runCleanup(project, undefined, {
        agent: async (_config, path) => {
          remember(path);
          if (failure === "auth") throw new Error("Authentication failed");
          if (failure === "infra") writeFileSync(join(path, "AGENTS.md"), "changed");
          if (failure === "symlink") symlinkSync(join(home, "gitconfig"), join(path, "bad.md"));
          if (failure === "invalid") writeFileSync(join(path, "NODE.md"), "invalid");
          if (failure === "staged") {
            writeFileSync(join(path, "NODE.md"), "staged");
            spawnSync("git", ["-C", path, "add", "NODE.md"]);
          }
        },
      });
      expect(result.outcome).toBe("failed");
      expect(result.worktreePath && existsSync(result.worktreePath)).toBe(true);
      expect(readState(statePath(config.id, "success"))).toBeUndefined();
    });
  }
  it("rejects a changed connection after model completion", async () => {
    const other = join(home, "other");
    mkdirSync(other);
    const otherTree = createProject(other).treePath;
    const finish = vi.fn();
    const result = await runCleanup(project, undefined, {
      finish,
      agent: async (_config, path) => {
        remember(path);
        connectProject({ projectPath: project, treePath: otherTree });
      },
    });
    expect(result.outcome).toBe("failed");
    expect(finish).not.toHaveBeenCalled();
    expect(removeCleanup(project, scheduler).schedule?.enabled).toBe(false);
  });
  it("prevents overlap and removal cancels remaining lifecycle steps", async () => {
    const finish = vi.fn();
    const result = await runCleanup(project, undefined, {
      finish,
      agent: async (_config, path) => {
        remember(path);
        await expect(runCleanup(project)).rejects.toThrow("already running");
        removeCleanup(project, scheduler);
      },
    });
    expect(result.outcome).toBe("cancelled");
    expect(finish).not.toHaveBeenCalled();
    expect(result.worktreePath && existsSync(result.worktreePath)).toBe(true);
  });
  it("does not retry outdated or uncertain publication and leaves checkpoint unchanged", async () => {
    for (const outdated of [true, false]) {
      const finish = vi.fn(() => {
        throw outdated
          ? new ContextTreeError(CLI_ERROR_CODES.writeOutdated, "advanced")
          : new Error("push disconnected");
      });
      const result = await runCleanup(project, undefined, {
        finish,
        agent: async (_config, path) => {
          remember(path);
          const file = join(path, "NODE.md");
          writeFileSync(file, `${readFileSync(file, "utf8")}\nConstraint.\n`);
        },
      });
      expect(result.outcome).toBe(outdated ? "failed" : "publication-uncertain");
      expect(finish).toHaveBeenCalledTimes(1);
      expect(readState(statePath(config.id, "success"))).toBeUndefined();
    }
  });
  it("executes fake CLI, and reports nonzero exits and timeout", async () => {
    expect(config.agentPath).toBe(join(home, "bin", "codex"));
    await expect(runAgent(config, project, "editorial", new AbortController().signal, 5000)).resolves.toBeUndefined();
    writeFileSync(config.agentPath, "#!/bin/sh\nexit 9\n");
    await expect(runAgent(config, project, "editorial", new AbortController().signal, 5000)).rejects.toThrow("failed");
    writeFileSync(config.agentPath, "#!/bin/sh\ncat >/dev/null\nsleep 20\n");
    await expect(runAgent(config, project, "editorial", new AbortController().signal, 20)).rejects.toThrow("timeout");
    expect(agentArguments(config)).toContain("workspace-write");
    expect(agentArguments({ ...config, agent: "claude" })).toContain("acceptEdits");
  }, 15000);
});

for (const platform of ["darwin", "linux"]) {
  it(`${platform} adapter writes isolated native jobs, never starts cleanup on install, and stops on removal`, () => {
    const calls: string[][] = [];
    const native = nativeScheduler(platform, home, (_command, args) => {
      calls.push(args);
      return { status: 0, stdout: "", stderr: "" };
    });
    native.install(config);
    const name = `ai.context-tree.cleanup.${config.id}`;
    const file =
      platform === "darwin"
        ? join(home, "Library", "LaunchAgents", `${name}.plist`)
        : join(home, ".config", "systemd", "user", `${name}.service`);
    const content = readFileSync(file, "utf8");
    expect(content).toContain(config.cliPath);
    expect(content).not.toContain("dangerously");
    expect(calls.flat()).not.toContain("kickstart");
    expect(calls.some((args) => args.includes("start") && args.includes(`${name}.service`))).toBe(false);
    native.remove(config);
    expect(existsSync(file)).toBe(false);
    expect(calls.flat()).toContain(platform === "darwin" ? "bootout" : "stop");
    expect(loadSchedule(config.id).id).toBe(config.id);
  });
}
