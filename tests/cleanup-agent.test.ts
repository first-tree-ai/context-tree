import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";
import { runAgent } from "../src/core/cleanup/agent.js";
import type { CleanupSchedule } from "../src/schemas.js";

const commands = vi.hoisted(() => ({ spawn: vi.fn(), spawnSync: vi.fn() }));
vi.mock("node:child_process", () => commands);

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.clearAllMocks();
});

for (const trigger of ["timeout", "cancellation"]) {
  it(`kills a surviving descendant after agent exit on ${trigger}`, async () => {
    vi.useFakeTimers();
    const child = Object.assign(new EventEmitter(), {
      pid: 313131,
      stdin: new PassThrough(),
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      kill: vi.fn(() => true),
    });
    commands.spawn.mockReturnValue(child);
    commands.spawnSync.mockReturnValue({ status: 0, stdout: "424242 313131\n", stderr: "" });
    const kill = vi.spyOn(process, "kill").mockReturnValue(true);
    const config: CleanupSchedule = {
      id: "a".repeat(64),
      projectPath: "/project",
      identity: "local:/tree",
      agent: "codex",
      model: "test",
      everyMinutes: 60,
      nodePath: "/node",
      cliPath: "/context-tree",
      agentPath: "/agent",
      searchPath: "/bin",
      enabled: true,
    };
    const controller = new AbortController();
    const run = runAgent(config, "/worktree", "Edit content", controller.signal, 100);
    const rejected = expect(run).rejects.toThrow(trigger === "timeout" ? "timeout" : "cancelled");
    let settled = false;
    void run.catch(() => {
      settled = true;
    });

    if (trigger === "timeout") await vi.advanceTimersByTimeAsync(100);
    else controller.abort();
    expect(kill).toHaveBeenCalledWith(424242, "SIGTERM");
    child.emit("close", null);
    // A second cancellation must not replace the original escalation or reason.
    controller.abort();
    await vi.advanceTimersByTimeAsync(4999);
    expect(settled).toBe(false);
    expect(kill).not.toHaveBeenCalledWith(424242, "SIGKILL");
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
    expect(kill).toHaveBeenCalledWith(424242, "SIGKILL");
    expect(child.kill.mock.calls).toEqual([["SIGTERM"], ["SIGKILL"]]);
    expect(vi.getTimerCount()).toBe(0);
  });
}

it("decodes split UTF-8 and sanitizes complete credential lines while draining oversized output", async () => {
  const { sanitizeLogText } = await import("../src/core/cleanup/history.js");
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  commands.spawn.mockReturnValue(child);
  const config: CleanupSchedule = {
    id: "a".repeat(64),
    projectPath: "/project",
    identity: "local:/tree",
    agent: "codex",
    everyMinutes: 60,
    nodePath: "/node",
    cliPath: "/cli",
    agentPath: "/agent",
    searchPath: "/bin",
    enabled: true,
  };
  const events: Array<{ source: string; text: string }> = [];
  const run = runAgent(config, "/worktree", "private prompt", new AbortController().signal, 1000, (source, text) =>
    events.push({ source, text: sanitizeLogText(text) }),
  );
  const encoded = Buffer.from("hello 🌳\n");
  child.stdout.write(encoded.subarray(0, 8));
  child.stdout.write(encoded.subarray(8));
  child.stdout.write("https://user:sec");
  child.stdout.write("ret@example.test/tree\n");
  child.stderr.write("Authorization: Bea");
  child.stderr.write("rer private-token\n");
  child.stdout.write("x".repeat(17000));
  child.stdout.write("secret\n\u001b[31mnext\u001b[0m\n");
  child.stderr.write("tail");
  child.emit("close", 0);
  await run;
  expect(events).toEqual([
    { source: "stdout", text: "hello 🌳" },
    { source: "stdout", text: "<redacted URL>" },
    { source: "stderr", text: "Authorization: Bearer <redacted>" },
    { source: "stdout", text: "[Oversized output line suppressed]" },
    { source: "stdout", text: "next" },
    { source: "stderr", text: "tail" },
  ]);
});
