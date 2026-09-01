import { spawnSync } from "node:child_process";

/**
 * The single injectable command runner shared by every Git and GitHub CLI
 * operation in the core. Tests substitute this to keep Git and `gh` behavior
 * hermetic.
 */
export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export function defaultRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

export type CommandOptions = {
  /** Human-facing failure message; stderr detail is appended when present. */
  message?: string | undefined;
  runner?: CommandRunner | undefined;
};

/** A failed Git or `gh` operation. Messages never include the argv. */
export class CommandError extends Error {
  public readonly command: "git" | "gh";
  public readonly status: number | null;
  public readonly stderr: string;

  public constructor(command: "git" | "gh", status: number | null, stderr: string, message: string) {
    const detail = sanitizeCommandOutput(stderr).trim();
    super(detail.length > 0 ? `${message}: ${detail}` : message);
    this.name = "CommandError";
    this.command = command;
    this.status = status;
    this.stderr = detail;
  }
}

/** Remove credentials and common access-token shapes before surfacing subprocess output. */
export function sanitizeCommandOutput(value: string): string {
  return value
    .replace(/((?:https?|ssh):\/\/)[^\s/@]+@/giu, "$1<redacted>@")
    .replace(/\b(?:gh[opsu]_[A-Za-z\d_]{20,}|github_pat_[A-Za-z\d_]{20,})\b/gu, "<redacted>")
    .replace(/(authorization\s*:\s*(?:bearer|token)\s+)[^\s]+/giu, "$1<redacted>");
}

function trimOutput(value: string): string {
  return value.trim();
}

function execute(runner: CommandRunner, command: "git" | "gh", args: string[], message: string): string {
  const result = runner(command, args);
  if (result.status !== 0) throw new CommandError(command, result.status, result.stderr, message);
  return trimOutput(result.stdout);
}

/** Run a Git command that is not scoped by `-C`, such as `git init <path>`. */
export function gitCommand(args: string[], options: CommandOptions = {}): string {
  return execute(options.runner ?? defaultRunner, "git", args, options.message ?? "A Git operation failed.");
}

/** Run `git -C <root> <args>` and return trimmed stdout, throwing on failure. */
export function git(root: string, args: string[], options: CommandOptions = {}): string {
  const runner = options.runner ?? defaultRunner;
  return execute(runner, "git", ["-C", root, ...args], options.message ?? "A Git operation failed.");
}

/** Run `git -C <root> <args>` and return trimmed stdout, or undefined on failure. */
export function optionalGit(root: string, args: string[], runner: CommandRunner = defaultRunner): string | undefined {
  const result = runner("git", ["-C", root, ...args]);
  if (result.status !== 0) return undefined;
  return trimOutput(result.stdout);
}

/** Run `gh <args>` and return trimmed stdout, throwing on failure. */
export function gh(args: string[], options: CommandOptions = {}): string {
  const runner = options.runner ?? defaultRunner;
  return execute(runner, "gh", args, options.message ?? "A GitHub CLI operation failed.");
}
