import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { runAgent, runReviewBatch } from "../src/adapters/agent.js";
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
function setup(script?: string): CleanupSchedule {
  const { project, home } = fixture();
  initRepository(project);
  initTree(project, join(project, "docs"));
  commit(project);
  const bin = join(home, "bin");
  mkdirSync(bin);
  writeFileSync(
    join(bin, "codex"),
    script ??
      `#!${process.execPath}
const fs = require("node:fs");
let body = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", chunk => { body += chunk; });
process.stdin.on("end", () => {
  const delimiter = "\\nBatch JSON input:\\n";
  if (body.includes(delimiter)) {
    if (!process.argv.includes("read-only")) process.exit(2);
    const id = /with id ([a-f0-9]{64}), reviewed/.exec(body)[1];
    const items = JSON.parse(body.split(delimiter)[1]);
    console.log(JSON.stringify({ id, reviewed: items.map(({ id }) => id), topics: [], notes: "" }));
  } else {
    const path = fs.readdirSync(".").find(name => name.startsWith(".context-tree-review-"));
    fs.writeFileSync(path, JSON.stringify({ status: "complete", summary: "Checked review scope." }));
  }
});
`,
    { mode: 0o700 },
  );
  vi.stubEnv("PATH", `${bin}:${process.env.PATH ?? ""}`);
  const result = scheduleCleanup({ projectPath: project, agent: "codex", every: "2h", publish: false }, scheduler);
  if (!result.schedule) throw new Error("Missing schedule");
  return result.schedule;
}
function completeEditor(run?: typeof runAgent): typeof runAgent {
  return async (...args) => {
    await run?.(...args);
    const root = args[1];
    const record = readdirSync(root).find((file) => file.startsWith(".context-tree-review-"));
    if (!record) throw new Error("Missing completion record in fixture.");
    writeFileSync(join(root, record), JSON.stringify({ status: "complete", summary: "Checked review scope." }));
  };
}
describe("cleanup through isolated sessions", () => {
  it("checks cross-batch originals and resumes without rereading acknowledged batches", async () => {
    const config = setup();
    const { project } = fixture();
    const docs = join(project, "docs");
    const original = new Map<string, string>();
    for (let i = 0; i < 22; i++) {
      const path = `page-${String(i).padStart(2, "0")}.md`;
      const claim =
        i === 0
          ? "Renew the lease automatically. See [lease policy](page-21.md#lease-recovery)."
          : i === 21
            ? "Require authorization before renewing the lease."
            : "Background.";
      const heading = i === 21 ? "Lease recovery" : `Topic ${i}`;
      const text = `${node(path)}\n## ${heading}\n\n${claim}\n${"字🌳".repeat(900)}\n`;
      original.set(path, text);
      writeFileSync(join(docs, path), text);
    }
    original.set("NODE.md", readFileSync(join(docs, "NODE.md"), "utf8"));
    commit(project);
    let rejectRelation = true;
    const reconstructed = new Map<string, string>();
    const ids: string[] = [];
    let linkedOriginals = false;
    let topicOriginals = false;
    const reviewBatch = vi.fn<typeof runReviewBatch>(async (_config, _root, _editorial, batch) => {
      expect(Buffer.byteLength(batch.payload)).toBeLessThanOrEqual(60_000);
      const data: { id: number; path?: string; text?: string; left?: { text: string }; right?: { text: string } }[] =
        JSON.parse(batch.payload);
      if (batch.kind === "reading") {
        ids.push(batch.id);
        for (const { path, text } of data) {
          if (path === undefined || text === undefined) throw new Error("Missing fragment");
          reconstructed.set(path, (reconstructed.get(path) ?? "") + text);
        }
      } else {
        linkedOriginals ||= data.some(
          ({ left, right }) =>
            left?.text.includes("Renew the lease automatically") && right?.text.includes("Require authorization"),
        );
        topicOriginals ||= data.some(
          ({ left, right }) => left?.text.includes("## Topic 1\n") && right?.text.includes("## Topic 20\n"),
        );
        if (rejectRelation) return JSON.stringify({ id: batch.id, reviewed: [], topics: [], notes: "" });
      }
      const topics =
        batch.kind === "reading"
          ? data
              .filter(({ text }) => text?.includes("## Topic 1\n") || text?.includes("## Topic 20\n"))
              .map(({ id }) => ({ part: id, key: "Shared operational rule" }))
          : [];
      return JSON.stringify({ id: batch.id, reviewed: data.map(({ id }) => id), topics, notes: "" });
    });
    const editor = vi.fn(completeEditor());
    const options = { reviewBatch, agent: editor };
    const failed = await runCleanup(project, undefined, undefined, options);
    expect(failed.outcome, failed.message).toBe("failed");
    expect(failed.message).toMatch(/receipt for every supplied item/);
    expect(editor).not.toHaveBeenCalled();
    expect(existsSync(statePath(config.id, "success"))).toBe(false);
    expect(reconstructed).toEqual(original);
    const readCount = ids.length;
    expect(readCount).toBeGreaterThan(1);
    rejectRelation = false;
    const completed = await runCleanup(project, undefined, undefined, options);
    expect(completed.outcome, completed.message).toBe("noop");
    expect(ids).toHaveLength(readCount);
    expect(linkedOriginals).toBe(true);
    expect(topicOriginals).toBe(true);
    expect(editor).toHaveBeenCalledTimes(1);
  }, 30_000);

  it("compares routine tidy with the last successful review and keeps failures out of the baseline", async () => {
    const config = setup();
    const { project } = fixture();
    writeFileSync(join(project, "docs/removed.md"), node("Removed"));
    writeFileSync(join(project, "docs/unchanged.md"), node("Unchanged"));
    commit(project);
    const first = await runCleanup(project);
    expect(first.outcome, first.message).toBe("noop");
    const success = statePath(config.id, "success");
    const baseline = readFileSync(success, "utf8");
    rmSync(join(project, "docs/removed.md"));
    writeFileSync(join(project, "docs/added.md"), node("Added"));
    commit(project);
    const batch = vi.fn<typeof runReviewBatch>(async () => {
      throw new Error("Unexpected structural pass");
    });
    const failure = await runCleanup(project, undefined, undefined, {
      agent: async () => undefined,
      reviewBatch: batch,
    });
    expect(failure.outcome).toBe("failed");
    expect(readFileSync(success, "utf8")).toBe(baseline);
    writeFileSync(join(project, "docs/changed.md"), node("Another change"));
    commit(project);
    const editor = completeEditor(async (_config, _root, prompt) => {
      expect(prompt).toContain("routine editing phase");
      expect(prompt).toContain("3 changed Markdown paths");
      const manifest = readFileSync(statePath(config.id, "review-changes"), "utf8").trim().split("\n");
      expect(manifest.map((line) => JSON.parse(line))).toEqual(["added.md", "changed.md", "removed.md"]);
    });
    const retry = await runCleanup(project, undefined, undefined, { agent: editor, reviewBatch: batch });
    expect(retry.outcome, retry.message).toBe("noop");
    expect(batch).not.toHaveBeenCalled();
    expect(readFileSync(success, "utf8")).not.toBe(baseline);
  });

  it("keeps a routine structural trigger pending without advancing the comparison base", async () => {
    const config = setup();
    const { project } = fixture();
    expect((await runCleanup(project)).outcome).toBe("noop");
    const success = statePath(config.id, "success");
    const baseline = readFileSync(success, "utf8");
    writeFileSync(join(project, "docs/added.md"), node("Second area"));
    commit(project);
    const requestReview: typeof runAgent = async (_config, root, prompt) => {
      expect(prompt).toContain("routine editing phase");
      const record = readdirSync(root).find((file) => file.startsWith(".context-tree-review-"));
      if (!record) throw new Error("Missing completion record in fixture.");
      writeFileSync(join(root, record), JSON.stringify({ status: "structural", summary: "Scattered topic." }));
    };
    const pause = await runCleanup(project, undefined, undefined, { agent: requestReview });
    expect(pause.outcome, pause.message).toBe("reviewing");
    expect(pause.sessionId).toBeUndefined();
    expect(readFileSync(success, "utf8")).toBe(baseline);
    const complete = await runCleanup(project, undefined, undefined, {
      agent: completeEditor(async (_config, _root, prompt) => {
        expect(prompt).toContain("structural editing phase");
        expect(prompt).toContain("1 changed Markdown paths");
      }),
    });
    expect(complete.outcome, complete.message).toBe("noop");
    expect(readFileSync(success, "utf8")).not.toBe(baseline);
  });

  it("retains a review branch, preserves host edits, and skips the same input subtree", async () => {
    const config = setup();
    const { project } = fixture();
    writeFileSync(join(project, "code.ts"), "host changes\n");
    const agent = vi.fn(async (_config, root: string) => {
      writeFileSync(join(root, "decision.md"), node("Decision"));
    });
    const result = await runCleanup(project, undefined, undefined, { agent: completeEditor(agent) });
    expect(result.outcome).toBe("committed");
    expect(result.sessionId).toBeTruthy();
    expect(readFileSync(join(project, "code.ts"), "utf8")).toBe("host changes\n");
    expect(existsSync(join(project, "docs/decision.md"))).toBe(false);
    const session = loadWriteSession(result.sessionId ?? "");
    expect(session.commit).toBe(result.sha);
    expect(readCleanupHistory(config.id).runs[0]?.terminal?.outcome).toBe("committed");
    commit(project, "Unrelated code edit");
    expect((await runCleanup(project, undefined, undefined, { agent: completeEditor(agent) })).outcome).toBe(
      "unchanged",
    );
    expect(agent).toHaveBeenCalledTimes(1);
    vi.useFakeTimers({ now: Date.now() + 25 * 60 * 60 * 1000, toFake: ["Date"] });
    try {
      expect((await runCleanup(project, undefined, undefined, { agent: completeEditor(agent) })).outcome).not.toBe(
        "unchanged",
      );
      expect(agent).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
    expect(removeCleanup(project, undefined, scheduler).schedule?.enabled).toBe(false);
    expect((await runCleanup(project, undefined, undefined, { agent })).outcome).toBe("inactive");
  });
  it("validates no-op runs, refuses infrastructure edits, and retains failed work", async () => {
    const config = setup();
    const { project } = fixture();
    const result = await runCleanup(project);
    expect(result.outcome).toBe("noop");
    rmSync(statePath(config.id, "success"));
    const invalid = await runCleanup(project, undefined, undefined, {
      agent: completeEditor(async (_config, root) => {
        writeFileSync(join(root, "AGENTS.md"), "Unwanted instructions");
      }),
    });
    expect(invalid.outcome).toBe("failed");
    expect(readFileSync(join(invalid.worktreePath ?? "", "AGENTS.md"), "utf8")).toContain("Unwanted");
    expect(cleanupStatus(project, undefined, scheduler).latest?.outcome).toBe("failed");
  });
  it("cancels when the schedule changes before completion and does not stage", async () => {
    const config = setup();
    const { project } = fixture();
    const result = await runCleanup(project, undefined, undefined, {
      agent: completeEditor(async (_config, root) => {
        writeFileSync(join(root, "decision.md"), node("Decision"));
        atomicState(statePath(config.id, "config"), { ...config, enabled: false });
      }),
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
      agent: completeEditor(async (_config, root) => {
        writeFileSync(join(root, "decision.md"), node("Decision"));
      }),
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
    agent: completeEditor(async (_config, root) => {
      writeFileSync(join(root, "cleaned.md"), node("Cleaned"));
    }),
  });
  expect(result.outcome).toBe("committed");
  const session = loadWriteSession(result.sessionId ?? "");
  expect(session.connection.source).toEqual({ kind: "directory", path: "docs" });
  disconnect(project, join(project, "docs"));
  expect(removeCleanup(project, join(project, "docs"), scheduler).schedule?.enabled).toBe(false);
  expect(cleanupStatus(project, join(other, "docs"), scheduler).schedule?.enabled).toBe(true);
});
