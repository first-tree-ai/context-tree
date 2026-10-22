import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { statePath } from "../src/adapters/cleanup-state.js";
import { git } from "../src/adapters/git.js";
import { CleanupHistory, MAX_LOG_BYTES, readCleanupHistory } from "../src/adapters/history.js";
import { type CleanupScheduler, nativeScheduler } from "../src/adapters/scheduler.js";
import { atomicState } from "../src/adapters/state.js";
import type { CleanupSchedule } from "../src/contracts/index.js";
import {
  cleanupStatus,
  parseCleanupInterval,
  removeCleanup,
  runCleanup,
  scheduleCleanup,
} from "../src/operations/cleanup.js";
import { disconnect } from "../src/operations/connections.js";
import { connectTree, initTree } from "../src/operations/trees.js";
import { loadWriteSession } from "../src/operations/write.js";
import { commit, initRepository, node, remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();
const scheduler: CleanupScheduler = {
  install: () => undefined,
  remove: () => undefined,
  status: () => ({ registered: true, running: false }),
};
function setup(): CleanupSchedule {
  const { project, home } = fixture();
  initRepository(project);
  initTree(project, join(project, "docs"));
  commit(project);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(join(bin, "codex"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  const result = scheduleCleanup({ projectPath: project, agent: "codex", every: "2h", publish: false }, scheduler);
  if (!result.schedule) throw new Error("Missing schedule");
  return result.schedule;
}
describe("cleanup through isolated sessions", () => {
  it("retains a review branch, preserves host edits, and skips the same input subtree", async () => {
    const config = setup();
    const { project } = fixture();
    writeFileSync(join(project, "code.ts"), "host changes\n");
    const agent = vi.fn(async (_config, root: string) => {
      writeFileSync(join(root, "decision.md"), node("Decision"));
    });
    const result = await runCleanup(project, undefined, undefined, { agent });
    expect(result.outcome).toBe("committed");
    expect(result.sessionId).toBeTruthy();
    expect(readFileSync(join(project, "code.ts"), "utf8")).toBe("host changes\n");
    expect(existsSync(join(project, "docs/decision.md"))).toBe(false);
    const session = loadWriteSession(result.sessionId ?? "");
    expect(session.commit).toBe(result.sha);
    expect(readCleanupHistory(config.id).runs[0]?.terminal?.outcome).toBe("committed");
    commit(project, "Unrelated code edit");
    expect((await runCleanup(project, undefined, undefined, { agent })).outcome).toBe("unchanged");
    expect(agent).toHaveBeenCalledTimes(1);
    expect(removeCleanup(project, undefined, scheduler).schedule?.enabled).toBe(false);
    expect((await runCleanup(project, undefined, undefined, { agent })).outcome).toBe("inactive");
  });
  it("validates no-op runs, refuses infrastructure edits, and retains failed work", async () => {
    const config = setup();
    const { project } = fixture();
    const result = await runCleanup(project, undefined, undefined, { agent: async () => undefined });
    expect(result.outcome).toBe("noop");
    rmSync(statePath(config.id, "success"));
    const invalid = await runCleanup(project, undefined, undefined, {
      agent: async (_config, root) => {
        writeFileSync(join(root, "AGENTS.md"), "Unwanted instructions");
      },
    });
    expect(invalid.outcome).toBe("failed");
    expect(readFileSync(join(invalid.worktreePath ?? "", "AGENTS.md"), "utf8")).toContain("Unwanted");
    expect(cleanupStatus(project, undefined, scheduler).latest?.outcome).toBe("failed");
  });
  it("cancels when the schedule changes before completion and does not stage", async () => {
    const config = setup();
    const { project } = fixture();
    const result = await runCleanup(project, undefined, undefined, {
      agent: async (_config, root) => {
        writeFileSync(join(root, "decision.md"), node("Decision"));
        atomicState(statePath(config.id, "config"), { ...config, enabled: false });
      },
    });
    expect(result.outcome).toBe("failed");
    expect(result.message).toMatch(/cancelled|changed/);
    const session = loadWriteSession(result.sessionId ?? "");
    expect(git(session.worktreeRoot ?? "", ["diff", "--cached", "--name-only"])).toBe("");
  });
  it("publishes only when the schedule explicitly authorizes a managed Git source", async () => {
    setup();
    const { project, home } = fixture();
    const remote = remoteFixture(home);
    connectTree(project, { kind: "git", repository: "acme/context", path: "docs", ref: "main" }, remote.runner);
    scheduleCleanup(
      { projectPath: project, tree: "context", agent: "codex", every: "1d", publish: true },
      scheduler,
      remote.runner,
    );
    const result = await runCleanup(project, "context", undefined, {
      runner: remote.runner,
      agent: async (_config, root) => {
        writeFileSync(join(root, "decision.md"), node("Decision"));
      },
    });
    expect(result.outcome).toBe("published");
    expect(git(remote.remote, ["rev-parse", "main"])).toBe(result.sha);
    expect(() =>
      scheduleCleanup({ projectPath: project, tree: "docs", agent: "codex", every: "1d", publish: true }, scheduler),
    ).toThrow(/Directory/);
  });
  it("accepts bounded intervals only", () => {
    expect(parseCleanupInterval("2h")).toBe(120);
    for (const value of ["0m", "1.5h", "366d", "1s", "-1h"]) expect(() => parseCleanupInterval(value)).toThrow();
  });
});
describe("native schedules and bounded history", () => {
  it("quotes macOS launchers literally and preserves unrelated launcher files", () => {
    const config = setup();
    const script = join(fixture().home, "agent ' $HOME $(exit 99).mjs");
    writeFileSync(script, "process.stdout.write(JSON.stringify(process.argv.slice(2))); process.exitCode = 37;\n");
    const native = nativeScheduler("darwin", fixture().home, () => ({ status: 0, stdout: "", stderr: "" }));
    const altered = { ...config, cliPath: script, projectPath: "/project ' $HOME $(exit 99)" };
    native.install(altered);
    const dir = join(fixture().home, ".context-tree/cleanup/launchers", config.id);
    const launcher = join(dir, "context-tree-cleanup");
    const result = spawnSync(launcher, { encoding: "utf8" });
    expect(result.status).toBe(37);
    expect(JSON.parse(result.stdout)).toEqual([
      "cleanup",
      "run",
      "--schedule-id",
      config.id,
      "--project-path",
      altered.projectPath,
      "--json",
    ]);
    writeFileSync(join(dir, "unrelated"), "keep");
    native.remove(altered);
    expect(existsSync(launcher)).toBe(false);
    expect(existsSync(join(dir, "unrelated"))).toBe(true);
  });
  it("rejects symlink scheduler destinations", () => {
    const config = setup();
    const { home } = fixture();
    mkdirSync(join(home, "Library"));
    symlinkSync(home, join(home, "Library/LaunchAgents"));
    const native = nativeScheduler("darwin", home, () => ({ status: 0, stdout: "", stderr: "" }));
    expect(() => native.install(config)).toThrow(/symlink/);
  });
  it("caps output, redacts secrets, preserves incomplete runs, and bounds finished history", () => {
    const config = setup();
    const incomplete = new CleanupHistory(config);
    const history = new CleanupHistory(config);
    history.event("stdout", "Authorization: Bearer very-secret\u001b[31m");
    history.event("stdout", "x".repeat(MAX_LOG_BYTES));
    history.finish({ at: Date.now(), outcome: "noop" });
    const logs = readCleanupHistory(config.id, { run: history.runId });
    expect(logs.events[0]?.text).toContain("<redacted>");
    expect(logs.events[0]?.text).not.toContain("very-secret");
    expect(logs.runs.find((run) => run.runId === history.runId)?.truncated).toBe(true);
    const root = join(fixture().home, ".context-tree/cleanup/logs", config.id);
    expect(statSync(join(root, history.runId, "events.jsonl")).size).toBeLessThan(MAX_LOG_BYTES);
    const unfinishedDirectory = join(root, randomUUID());
    mkdirSync(unfinishedDirectory);
    for (let i = 0; i < 55; i++) new CleanupHistory(config).finish({ at: Date.now(), outcome: "noop" });
    const runs = readCleanupHistory(config.id, { list: true }).runs;
    expect(runs).toHaveLength(50);
    expect(runs.some((run) => run.runId === incomplete.runId)).toBe(true);
    expect(existsSync(unfinishedDirectory)).toBe(true);
  });
  it("rejects symlinked event files", () => {
    const config = setup();
    const history = new CleanupHistory(config);
    const events = join(fixture().home, ".context-tree/cleanup/logs", config.id, history.runId, "events.jsonl");
    rmSync(events);
    symlinkSync(join(fixture().home, "gitconfig"), events);
    expect(() => history.event("stdout", "hello")).toThrow(/store cleanup logs/);
    expect(() => readCleanupHistory(config.id)).toThrow();
  });
});

it("keeps schedules attached to full sources after a namesake is connected, including removal after disconnect", async () => {
  const config = setup();
  const { project, home } = fixture();
  const other = join(home, "other");
  initRepository(other);
  initTree(other, join(other, "docs"));
  commit(other);
  connectTree(project, { kind: "directory", path: join(other, "docs") });
  const second = scheduleCleanup(
    { projectPath: project, tree: join(other, "docs"), agent: "codex", every: "1d", publish: false },
    scheduler,
  );
  expect(second.schedule?.id).not.toBe(config.id);
  expect(() => cleanupStatus(project, "docs", scheduler)).toThrow(/exact source/);
  const result = await runCleanup(project, undefined, config.id, {
    agent: async (_config, root) => {
      writeFileSync(join(root, "cleaned.md"), node("Cleaned"));
    },
  });
  expect(result.outcome).toBe("committed");
  const session = loadWriteSession(result.sessionId ?? "");
  expect(session.connection.source).toEqual({ kind: "directory", path: "docs" });
  disconnect(project, join(project, "docs"));
  expect(removeCleanup(project, join(project, "docs"), scheduler).schedule?.enabled).toBe(false);
  expect(cleanupStatus(project, join(other, "docs"), scheduler).schedule?.enabled).toBe(true);
});
