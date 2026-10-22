import type { SpawnOptions, SpawnSyncOptionsWithStringEncoding } from "node:child_process";
import { spawnSync } from "node:child_process";

/**
 * The single injectable command runner shared by every Git
 * operation in the core. Tests substitute this to keep Git behavior
 * hermetic.
 */
export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export function defaultRunner(command: string, args: string[], timeoutMs = 120_000): CommandResult {
  const env = { ...process.env };
  if (command === "git") {
    for (const key of [
      "GIT_DIR",
      "GIT_WORK_TREE",
      "GIT_INDEX_FILE",
      "GIT_COMMON_DIR",
      "GIT_OBJECT_DIRECTORY",
      "GIT_ALTERNATE_OBJECT_DIRECTORIES",
      "GIT_PREFIX",
      "GIT_SHALLOW_FILE",
      "GIT_NAMESPACE",
      "GIT_CONFIG",
    ])
      delete env[key];
  }
  const options: SpawnSyncOptionsWithStringEncoding & Pick<SpawnOptions, "detached"> = {
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: timeoutMs,
    killSignal: "SIGKILL",
    detached: process.platform !== "win32",
  };
  const result = spawnSync(command, args, options);
  const timedOut = result.error !== undefined && "code" in result.error && result.error.code === "ETIMEDOUT";
  if (timedOut && process.platform !== "win32" && result.pid) {
    // Git's SSH/credential children must not outlive a timed-out operation.
    try {
      process.kill(-result.pid, "SIGKILL");
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
    }
  }
  return {
    status: result.status,
    stderr: timedOut
      ? `Command timed out after ${timeoutMs} ms.`
      : result.error
        ? "Unable to start command."
        : typeof result.stderr === "string"
          ? result.stderr
          : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export type CommandOptions = {
  /** Human-facing failure message; stderr detail is appended when present. */
  message?: string | undefined;
  runner?: CommandRunner | undefined;
};

/** Remove credentials and common access-token shapes before surfacing subprocess output. */
export function sanitizeCommandOutput(value: string): string {
  return value
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/\b(?:gh[opsu]_[A-Za-z\d_]{20,}|github_pat_[A-Za-z\d_]{20,})\b/gu, "<redacted>")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+/giu, "$1<redacted>");
}

/** Run `git -C <root> <args>` and return trimmed stdout, throwing on failure. */
export function git(root: string, args: string[], options: CommandOptions = {}): string {
  return gitRaw(root, args, options).trim();
}

/** Run `git -C <root> <args>` and return trimmed stdout, or undefined on failure. */
export function optionalGit(root: string, args: string[], runner: CommandRunner = defaultRunner): string | undefined {
  const result = runner("git", ["-C", root, ...args]);
  if (result.status !== 0) return undefined;
  return result.stdout.trim();
}

/** Preserve NUL-delimited paths exactly, including leading/trailing whitespace. */
export function gitRaw(root: string, args: string[], options: CommandOptions = {}): string {
  const result = (options.runner ?? defaultRunner)("git", ["-C", root, ...args]);
  if (result.status !== 0) {
    const detail = sanitizeCommandOutput(result.stderr).trim();
    throw new Error(`${options.message ?? "A Git operation failed."}${detail ? `: ${detail}` : ""}`);
  }
  return result.stdout;
}
