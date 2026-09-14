import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
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
  writeFileSync(join(bin, "pi"), "#!/bin/sh\ncat >/dev/null\nexit 0\n", { mode: 0o700 });
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
  it("keeps a pi schedule model-agnostic and resolves the pi binary", () => {
    const result = scheduleCleanup({ projectPath: project, agent: "pi" }, scheduler);
    expect(result.schedule?.agent).toBe("pi");
    expect(result.schedule?.model).toBeUndefined();
    expect(result.schedule?.agentPath).toBe(join(home, "bin", "pi"));
    expect(agentArguments({ ...config, agent: "pi", model: undefined })).toEqual([
      "-p",
      "--tools",
      "read,edit,write,grep,find,ls",
      "--no-session",
      "--no-extensions",
    ]);
    expect(agentArguments({ ...config, agent: "pi", model: "anthropic/claude-haiku-4-5" })).toEqual([
      "-p",
      "--tools",
      "read,edit,write,grep,find,ls",
      "--no-session",
      "--no-extensions",
      "--model",
      "anthropic/claude-haiku-4-5",
    ]);
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
    expect(content).toContain(platform === "darwin" ? "context-tree-cleanup" : config.cliPath);
    if (platform === "darwin") {
      expect(content).toContain("<key>RunAtLoad</key><false/>");
      expect(content).toContain(`<key>StartInterval</key><integer>${config.everyMinutes * 60}</integer>`);
      expect(content).toContain(`<key>WorkingDirectory</key><string>${config.projectPath}</string>`);
      expect(content).toContain(`<key>PATH</key><string>${config.searchPath}</string>`);
    }
    expect(content).not.toContain("dangerously");
    expect(calls.flat()).not.toContain("kickstart");
    expect(calls.some((args) => args.includes("start") && args.includes(`${name}.service`))).toBe(false);
    native.remove(config);
    expect(existsSync(file)).toBe(false);
    expect(calls.flat()).toContain(platform === "darwin" ? "bootout" : "stop");
    expect(loadSchedule(config.id).id).toBe(config.id);
  });
}

describe("macOS cleanup launcher", () => {
  it("finishes removal after a bootout error only when the job is confirmed absent", () => {
    for (const registered of [true, false]) {
      const adapter = nativeScheduler("darwin", home, (_command, args) => {
        if (args[0] === "bootout") return { status: 5, stdout: "", stderr: "Boot-out failed: 5: Input/output error" };
        return registered
          ? { status: 0, stdout: "state = waiting", stderr: "" }
          : { status: 113, stdout: "", stderr: "Could not find service" };
      });
      if (registered) expect(() => adapter.remove(config)).toThrow("Native cleanup scheduler operation failed");
      else expect(() => adapter.remove(config)).not.toThrow();
    }
  });

  const launcherPath = (): string =>
    join(home, ".context-tree", "cleanup", "launchers", config.id, "context-tree-cleanup");
  const native = (): CleanupScheduler => nativeScheduler("darwin", home, () => ({ status: 0, stdout: "", stderr: "" }));

  it("executes exact quoted arguments and preserves exit status across reinstall and removal", () => {
    const special = "spaces ' $HOME $(exit 99) ; & < > \"";
    const bin = join(home, special);
    mkdirSync(bin);
    const command = join(bin, "fake node");
    writeFileSync(command, '#!/bin/sh\nprintf "%s\\0" "$@"\nexit 37\n', { mode: 0o700 });
    const updated = { ...config, nodePath: command, cliPath: join(bin, "cli"), projectPath: join(bin, "project") };
    const adapter = native();
    for (let i = 0; i < 2; i++) {
      adapter.install(updated);
      const launcher = launcherPath();
      expect(statSync(launcher).mode & 0o777).toBe(0o700);
      const result = spawnSync(launcher, [], { encoding: "utf8" });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(37);
      expect(result.stdout.split("\0")).toEqual([
        updated.cliPath,
        "cleanup",
        "run",
        "--schedule-id",
        config.id,
        "--project-path",
        updated.projectPath,
        "--json",
        "",
      ]);
    }
    adapter.remove(updated);
    expect(existsSync(join(launcherPath(), ".."))).toBe(false);
    adapter.remove(updated);
  });

  it.each(["launchers", "schedule", "file"])("rejects a symlinked %s on install and removal", (kind) => {
    const parent = join(home, ".context-tree", "cleanup", "launchers");
    const schedule = join(parent, config.id);
    const target = join(home, "outside");
    if (kind === "file") writeFileSync(target, "untouched");
    else mkdirSync(target);
    if (kind !== "launchers") mkdirSync(parent);
    if (kind === "file") mkdirSync(schedule);
    symlinkSync(target, kind === "launchers" ? parent : kind === "schedule" ? schedule : launcherPath());
    const adapter = native();
    expect(() => adapter.install(config)).toThrow(/symlink|Unsafe/u);
    expect(() => adapter.remove(config)).toThrow(/symlink|Unsafe/u);
    if (kind === "file") expect(readFileSync(target, "utf8")).toBe("untouched");
  });

  it("preserves unrelated files in a launcher directory on removal", () => {
    const adapter = native();
    adapter.install(config);
    const other = join(launcherPath(), "..", "other");
    writeFileSync(other, "keep");
    adapter.remove(config);
    expect(existsSync(launcherPath())).toBe(false);
    expect(readFileSync(other, "utf8")).toBe("keep");
  });
});

describe("cleanup history", () => {
  it("records synchronization before Git runs and preserves its failure in history", async () => {
    const { cleanupLogs } = await import("../src/core/cleanup/index.js");
    const agent = vi.fn();
    const result = await runCleanup(project, undefined, {
      agent,
      sync: () => {
        expect(cleanupStatus(project, scheduler).latest).toMatchObject({
          outcome: "running",
          message: "Synchronizing Context Tree.",
        });
        expect(cleanupLogs(project).events.at(-1)?.text).toBe("Synchronizing Context Tree.");
        throw new Error("Command timed out after 120000 ms.");
      },
    });
    expect(result.outcome).toBe("failed");
    expect(cleanupLogs(project).runs[0]?.terminal).toEqual(result);
    expect(cleanupLogs(project).events.at(-1)?.text).toContain("timed out");
    expect(existsSync(statePath(config.id, "lock"))).toBe(false);
    expect(agent).not.toHaveBeenCalled();
  });
  it("records skips, shares history, preserves removed schedules and activity", async () => {
    const { cleanupLogs } = await import("../src/core/cleanup/index.js");
    expect(cleanupLogs(project).runs).toEqual([]);
    atomicState(statePath(config.id, "activity"), 1);
    const outcome = await runCleanup(project);
    expect(outcome.outcome).toBe("inactive");
    expect(outcome.runId).toBeDefined();
    const second = join(home, "second-history");
    mkdirSync(second);
    connectProject({ projectPath: second, treePath: tree });
    expect(cleanupLogs(second)).toEqual(cleanupLogs(project));
    removeCleanup(project, scheduler);
    expect(cleanupLogs(project).runs[0]?.terminal).toEqual(outcome);
    expect(cleanupLogs(project, { list: true }).events).toEqual([]);
    expect(readState(statePath(config.id, "activity"))).toBe(1);
    expect(() => cleanupLogs(project, { run: "../escape" })).toThrow();
    expect(() => cleanupLogs(project, { run: "00000000-0000-4000-8000-000000000000" })).toThrow("Unknown");
    expect(() => cleanupLogs(project, { list: true, run: outcome.runId ?? "" })).toThrow("mutually exclusive");
  });
  it("caps output, retains terminal metadata, prunes completed history and rejects symlinks", async () => {
    const { CleanupHistory, MAX_LOG_BYTES, readCleanupHistory } = await import("../src/core/cleanup/history.js");
    const incomplete = new CleanupHistory(config);
    expect(readCleanupHistory(config.id).runs[0]?.terminal).toBeUndefined();
    const log = new CleanupHistory(config);
    for (let i = 0; i < 600; i++) log.event("stdout", "x".repeat(10000));
    log.finish({ at: Date.now(), outcome: "failed", runId: log.runId });
    const path = join(home, ".context-tree", "cleanup", "logs", config.id, log.runId, "events.jsonl");
    expect(statSync(path).size).toBeLessThanOrEqual(MAX_LOG_BYTES);
    expect(
      readCleanupHistory(config.id, { run: log.runId }).runs.find((run) => run.runId === log.runId)?.truncated,
    ).toBe(true);
    for (let i = 0; i < 51; i++) {
      const entry = new CleanupHistory(config);
      entry.finish({ at: Date.now(), outcome: "noop" });
    }
    const runs = readCleanupHistory(config.id, { list: true }).runs;
    expect(runs).toHaveLength(50);
    expect(runs.some((run) => run.runId === incomplete.runId)).toBe(true);
    const events = join(home, ".context-tree", "cleanup", "logs", config.id, incomplete.runId, "events.jsonl");
    rmSync(events);
    symlinkSync(join(home, "gitconfig"), events);
    expect(() => readCleanupHistory(config.id, { run: incomplete.runId })).toThrow();
    expect(() => incomplete.event("stdout", "unsafe")).toThrow();
    expect(readFileSync(join(home, "gitconfig"), "utf8")).not.toContain("unsafe");
  });
  it("formats empty, list and selected JSON/text logs without refreshing activity", async () => {
    const invoke = async (args: string[]): Promise<string> => {
      let stdout = "";
      let stderr = "";
      await runContextTreeCli(["node", "context-tree", "cleanup", "logs", ...args], {
        cwd: () => project,
        stdout: (value) => {
          stdout += value;
        },
        stderr: (value) => {
          stderr += value;
        },
      });
      expect(stderr).toBe("");
      return stdout;
    };
    expect(await invoke([])).toBe(
      `No cleanup logs recorded for project ${project}.\nUse --project-path <path> to query another project's Context Tree.\n`,
    );
    atomicState(statePath(config.id, "activity"), 1);
    const result = await runCleanup(project);
    expect(await invoke(["--list"])).toContain(result.runId);
    const otherProject = join(home, "other-project");
    mkdirSync(otherProject);
    createProject(otherProject);
    expect(await invoke(["--project-path", otherProject])).toContain(
      `No cleanup logs recorded for project ${otherProject}.`,
    );
    expect(await invoke(["--project-path", project, "--list"])).toContain(result.runId);
    const output = await invoke(["--run", result.runId ?? "", "--json"]);
    expect(output.trim().split("\n")).toHaveLength(1);
    expect(JSON.parse(output).events.map((event: { source: string }) => event.source)).toEqual(["runner", "runner"]);
    expect(readState(statePath(config.id, "activity"))).toBe(1);
  });
});

it("stops before publication on log failure and preserves the worktree", async () => {
  const { cleanupLogs } = await import("../src/core/cleanup/index.js");
  const finish = vi.fn();
  const result = await runCleanup(project, undefined, {
    agent: async (_config, worktree, _prompt, _signal, _timeout, output) => {
      remember(worktree);
      const runId = cleanupLogs(project).selectedRunId;
      const events = join(home, ".context-tree", "cleanup", "logs", config.id, runId ?? "", "events.jsonl");
      rmSync(events);
      symlinkSync(join(home, "gitconfig"), events);
      output?.("stdout", "agent output");
    },
    finish,
  });
  expect(result.outcome).toBe("failed");
  expect(finish).not.toHaveBeenCalled();
  expect(existsSync(result.worktreePath ?? "")).toBe(true);
  expect(readState(statePath(config.id, "latest"))).toMatchObject({ outcome: "failed", runId: result.runId });
});
