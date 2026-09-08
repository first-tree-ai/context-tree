import { spawn, spawnSync } from "node:child_process";
import type { CleanupSchedule } from "../../schemas.js";

export function agentArguments(config: CleanupSchedule): string[] {
  return config.agent === "codex"
    ? [
        "exec",
        "--sandbox",
        "workspace-write",
        "-c",
        'approval_policy="never"',
        "-c",
        'model_reasoning_effort="low"',
        "--model",
        config.model,
        "--ephemeral",
        "-",
      ]
    : [
        "-p",
        "--model",
        config.model,
        "--permission-mode",
        "acceptEdits",
        "--tools",
        "Read,Edit,Write,Glob,Grep",
        "--allowedTools",
        "Read,Edit,Write,Glob,Grep",
        "--no-session-persistence",
      ];
}
export async function runAgent(
  config: CleanupSchedule,
  worktree: string,
  prompt: string,
  signal: AbortSignal,
  timeoutMs = 15 * 60 * 1000,
): Promise<void> {
  if (signal.aborted) throw new Error("Cleanup cancelled.");
  await new Promise<void>((resolve, reject) => {
    const child = spawn(config.agentPath, agentArguments(config), {
      cwd: worktree,
      env: { ...process.env, PATH: config.searchPath, CONTEXT_TREE_CLEANUP: "1" },
      stdio: ["pipe", "ignore", "ignore"],
    });
    let failure: string | undefined;
    let termination: Promise<void> | undefined;
    const stop = (reason: string): void => {
      if (termination !== undefined) return;
      failure = reason;
      clearTimeout(timer);
      const descendants = child.pid === undefined ? [] : childProcesses(child.pid);
      // Keep escalation alive even when the CLI exits before its descendants.
      termination = new Promise<void>((finished) => {
        setTimeout(() => {
          for (const pid of descendants) kill(pid, "SIGKILL");
          child.kill("SIGKILL");
          finished();
        }, 5000);
      });
      for (const pid of descendants.reverse()) kill(pid, "SIGTERM");
      child.kill("SIGTERM");
    };
    const abort = (): void => stop("Cleanup cancelled.");
    const timer = setTimeout(() => stop("Cleanup agent exceeded its 15-minute timeout."), timeoutMs);
    signal.addEventListener("abort", abort, { once: true });
    child.stdin.on("error", () => undefined);
    child.stdin.end(prompt);
    child.on("error", () => {
      failure = "Unable to launch cleanup agent.";
    });
    child.on("close", async (code) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      await termination;
      if (failure || code !== 0)
        reject(new Error(failure ?? "Cleanup agent failed; check CLI authentication and model access."));
      else resolve();
    });
  });
}

function kill(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(pid, signal);
  } catch {
    /* Process already exited. */
  }
}
function childProcesses(parent: number): number[] {
  const result = spawnSync("ps", ["-axo", "pid=,ppid="], { encoding: "utf8" });
  const pairs =
    result.stdout
      ?.trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/u).map(Number)) ?? [];
  const children: number[] = [];
  const visit = (pid: number): void => {
    for (const [child, owner] of pairs) {
      if (owner === pid && child !== undefined && !children.includes(child)) {
        children.push(child);
        visit(child);
      }
    }
  };
  visit(parent);
  return children;
}
