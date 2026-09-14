import { spawn, spawnSync } from "node:child_process";
import type { CleanupSchedule } from "../../schemas.js";

/** Pi built-in tools mirroring the Claude editing allowlist; Bash stays disabled. */
const PI_CLEANUP_TOOLS = "read,edit,write,grep,find,ls";

export function agentArguments(config: CleanupSchedule): string[] {
  if (config.agent === "codex") {
    const args = [
      "exec",
      "--sandbox",
      "workspace-write",
      "-c",
      'approval_policy="never"',
      "-c",
      'model_reasoning_effort="low"',
    ];
    if (config.model !== undefined) args.push("--model", config.model);
    args.push("--ephemeral", "-");
    return args;
  }
  if (config.agent === "pi") {
    const args = ["-p", "--tools", PI_CLEANUP_TOOLS, "--no-session", "--no-extensions"];
    // Without a recorded model, Pi uses its own configured default. Keeping the flag out means an
    // unauthenticated hardcoded provider can never be selected on the user's behalf.
    if (config.model !== undefined) args.push("--model", config.model);
    return args;
  }
  const args = [
    "-p",
    "--permission-mode",
    "acceptEdits",
    "--tools",
    "Read,Edit,Write,Glob,Grep",
    "--allowedTools",
    "Read,Edit,Write,Glob,Grep",
    "--no-session-persistence",
  ];
  if (config.model !== undefined) args.push("--model", config.model);
  return args;
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
