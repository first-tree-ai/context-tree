import { createHash } from "node:crypto";
import {
  accessSync,
  constants,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
} from "node:fs";
import { delimiter, join, resolve } from "node:path";
import { z } from "zod";
import {
  type CleanupOutcome,
  type CleanupResult,
  type CleanupSchedule,
  type ContextTreeState,
  cleanupAgentSchema,
  cleanupOutcomeSchema,
  cleanupResultSchema,
  cleanupScheduleSchema,
  SCHEMA_VERSION,
} from "../../schemas.js";
import { findConnectionRecord, resolveConnectionRecord } from "../connections.js";
import { classifyContextContent } from "../internal/content-class.js";
import { git, sanitizeCommandOutput } from "../internal/git.js";
import { resolvePackagedResource } from "../internal/packaged-resource.js";
import { canonicalProjectRoot } from "../internal/project.js";
import { syncProject } from "../sync.js";
import { verifyTree } from "../verify.js";
import { finishContextWrite, prepareContextWrite } from "../write.js";
import { runAgent } from "./agent.js";
import { type CleanupScheduler, nativeScheduler } from "./scheduler.js";
import {
  activity,
  atomicState,
  cleanupRoot,
  identityId,
  loadSchedule,
  readState,
  schedules,
  statePath,
  treeIdentity,
} from "./store.js";

export function parseCleanupInterval(value = "1h"): number {
  const match = /^(\d+)(m|h|d)$/u.exec(value);
  const minutes = Number(match?.[1]) * (match?.[2] === "d" ? 1440 : match?.[2] === "h" ? 60 : 1);
  if (!match || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600)
    throw new Error(
      "Cleanup cadence must be a positive whole-minute duration (for example 30m, 1h, 1d), at most 365d.",
    );
  return minutes;
}
function executable(name: string): string {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const path = resolve(directory, name);
    try {
      accessSync(path, constants.X_OK);
      if (lstatSync(realpathSync(path)).isFile()) return realpathSync(path);
    } catch {
      /* try next PATH entry */
    }
  }
  throw new Error(`Install ${name} on PATH before scheduling cleanup.`);
}
function findSchedule(project: string): CleanupSchedule | undefined {
  const canonical = canonicalProjectRoot(project);
  // Saved project lookup remains available after a connection changes or disappears.
  const owned = schedules().filter((config) => config.projectPath === canonical);
  if (owned.length > 1)
    throw new Error("Multiple saved cleanup identities for this project; remove the old schedule first.");
  if (owned[0]) return owned[0];
  const connection = findConnectionRecord(canonical);
  return connection ? schedules().find((config) => config.id === identityId(treeIdentity(connection.tree))) : undefined;
}
export function cleanupStatus(project: string, scheduler: CleanupScheduler = nativeScheduler()): CleanupResult {
  const config = findSchedule(project);
  if (!config)
    return {
      schemaVersion: SCHEMA_VERSION,
      schedule: null,
      registered: false,
      running: false,
      inactive: true,
      lastActivity: null,
      latest: null,
    };
  const lastActivity = activity(config.id);
  const latest = readState(statePath(config.id, "latest"));
  return cleanupResultSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    schedule: config,
    ...scheduler.status(config),
    inactive: lastActivity === null || Date.now() - lastActivity > 86400000,
    lastActivity,
    latest: latest === undefined ? null : cleanupOutcomeSchema.parse(latest),
  });
}
function manage<T>(operation: () => T): T {
  const path = join(cleanupRoot(), ".management-lock");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new Error("Another cleanup management operation is in progress.");
  }
  try {
    return operation();
  } finally {
    rmSync(path, { recursive: true });
  }
}
export function scheduleCleanup(
  options: { projectPath: string; agent: string; model?: string; every?: string },
  scheduler: CleanupScheduler = nativeScheduler(),
): CleanupResult {
  return manage(() => scheduleCleanupUnlocked(options, scheduler));
}
export function removeCleanup(project: string, scheduler: CleanupScheduler = nativeScheduler()): CleanupResult {
  return manage(() => removeCleanupUnlocked(project, scheduler));
}
function scheduleCleanupUnlocked(
  options: { projectPath: string; agent: string; model?: string; every?: string },
  scheduler: CleanupScheduler = nativeScheduler(),
): CleanupResult {
  const agent = cleanupAgentSchema.parse(options.agent);
  const connection = resolveConnectionRecord(options.projectPath);
  const identity = treeIdentity(connection.tree);
  const previous = findSchedule(connection.projectPath);
  if (previous?.enabled && previous.identity !== identity)
    throw new Error("Remove the previous cleanup schedule before scheduling a changed connection.");
  const id = identityId(identity);
  const config = cleanupScheduleSchema.parse({
    id,
    projectPath: connection.projectPath,
    identity,
    agent,
    model: options.model ?? (agent === "codex" ? "gpt-5.6-luna" : "claude-haiku-4-5"),
    everyMinutes: parseCleanupInterval(options.every),
    nodePath: realpathSync(process.execPath),
    cliPath: resolvePackagedResource("dist", "cli", "index.mjs"),
    agentPath: executable(agent),
    searchPath: process.env.PATH ?? "",
    enabled: true,
  });
  if (scheduler.status(config).running || lstatSync(statePath(id, "lock"), { throwIfNoEntry: false }))
    throw new Error("Cleanup is running; remove it before changing the schedule.");
  if (previous && previous.id !== id) rmSync(statePath(previous.id, "config"));
  atomicState(statePath(id, "config"), config);
  atomicState(statePath(id, "activity"), Date.now());
  try {
    scheduler.install(config);
  } catch (error) {
    atomicState(statePath(id, "config"), { ...config, enabled: false });
    throw error;
  }
  return cleanupStatus(connection.projectPath, scheduler);
}
function removeCleanupUnlocked(project: string, scheduler: CleanupScheduler = nativeScheduler()): CleanupResult {
  const config = findSchedule(project);
  if (!config) return cleanupStatus(project, scheduler);
  atomicState(statePath(config.id, "config"), { ...config, enabled: false });
  scheduler.remove(config);
  const latest = cleanupOutcomeSchema.safeParse(readState(statePath(config.id, "latest")));
  if (latest.success && latest.data.outcome === "running") {
    atomicState(statePath(config.id, "latest"), {
      ...latest.data,
      at: Date.now(),
      outcome: latest.data.message === "publishing" ? "publication-uncertain" : "cancelled",
      message:
        "Stopped. Unfinished worktrees are preserved; publication already underway may have completed. No rollback or retry was attempted.",
    });
  }
  // Only discard a lock belonging to a process which has actually exited.
  const owner = z
    .number()
    .int()
    .positive()
    .safeParse(readState(join(statePath(config.id, "lock"), "owner")));
  if (owner.success && !alive(owner.data)) rmSync(statePath(config.id, "lock"), { recursive: true });
  return cleanupStatus(project, scheduler);
}
function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}
/** CLI-only, best effort: the background process and all its child CLIs are excluded. */
export function recordCleanupActivity(options: { projectPath?: string; treePath?: string }): void {
  if (process.env.CONTEXT_TREE_CLEANUP === "1") return;
  try {
    const tree = options.projectPath ? findConnectionRecord(options.projectPath)?.tree : undefined;
    for (const config of schedules()) {
      if (!config.enabled) continue;
      let matches = tree !== undefined && treeIdentity(tree) === config.identity;
      if (options.treePath) {
        const supplied = realpathSync(options.treePath);
        const connection = findConnectionRecord(config.projectPath);
        matches ||=
          connection !== undefined &&
          treeIdentity(connection.tree) === config.identity &&
          realpathSync(connection.tree.path) === supplied;
      }
      if (matches) atomicState(statePath(config.id, "activity"), Date.now());
    }
  } catch {
    /* Never turn an ordinary command into a failure. */
  }
}
function snapshot(root: string): Map<string, string> {
  const result = new Map<string, string>();
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, `${name}/`);
      else if (entry.isFile())
        result.set(name, `${lstatSync(path).mode}:${createHash("sha256").update(readFileSync(path)).digest("hex")}`);
      else result.set(name, entry.isSymbolicLink() ? `symlink:${readlinkSync(path)}` : "unsupported");
    }
  };
  walk(root, "");
  return result;
}
function inspectEdits(root: string, before: Map<string, string>): boolean {
  const after = snapshot(root);
  let changed = false;
  for (const name of new Set([...before.keys(), ...after.keys()])) {
    if (before.get(name) === after.get(name)) continue;
    if (
      !name.endsWith(".md") ||
      classifyContextContent(name) === "repo-infra" ||
      before.get(name) === "unsupported" ||
      after.get(name) === "unsupported" ||
      before.get(name)?.startsWith("symlink:") ||
      after.get(name)?.startsWith("symlink:")
    )
      throw new Error("Cleanup agent changed infrastructure, a symlink, or unsupported content.");
    changed = true;
  }
  // Include the index: an agent must not stage infrastructure or install symlinks.
  const staged = git(root, ["diff", "--cached", "--name-only", "-z"]);
  if (staged.length > 0) throw new Error("Cleanup agent staged changes; editorial workers must not stage.");
  return changed;
}
export type CleanupRunDependencies = {
  agent?: typeof runAgent;
  prepare?: typeof prepareContextWrite;
  finish?: typeof finishContextWrite;
  sync?: typeof syncProject;
};
export async function runCleanup(
  project: string,
  savedId?: string,
  dependencies: CleanupRunDependencies = {},
): Promise<CleanupOutcome> {
  const config = savedId ? loadSchedule(savedId) : findSchedule(project);
  if (!config) throw new Error("No cleanup schedule exists for this project.");
  const lock = statePath(config.id, "lock");
  manage(() => {
    const entry = lstatSync(lock, { throwIfNoEntry: false });
    if (entry) {
      if (!entry.isDirectory() || entry.isSymbolicLink()) throw new Error("Unsafe cleanup lock.");
      const owner = z
        .number()
        .int()
        .positive()
        .parse(readState(join(lock, "owner")));
      if (alive(owner)) throw new Error("Cleanup already running.");
      rmSync(lock, { recursive: true });
    }
    mkdirSync(lock, { mode: 0o700 });
    atomicState(join(lock, "owner"), process.pid);
  });
  const controller = new AbortController();
  const cancel = (): void => controller.abort();
  process.on("SIGTERM", cancel);
  process.on("SIGINT", cancel);
  let worktreePath: string | undefined;
  let publishing = false;
  const record = (outcome: CleanupOutcome["outcome"], extra: Partial<CleanupOutcome> = {}): CleanupOutcome => {
    const value = cleanupOutcomeSchema.parse({
      at: Date.now(),
      outcome,
      ...(worktreePath ? { worktreePath } : {}),
      ...extra,
    });
    atomicState(statePath(config.id, "latest"), value);
    return value;
  };
  const check = (): void => {
    const current = loadSchedule(config.id);
    if (controller.signal.aborted || !current.enabled || JSON.stringify(current) !== JSON.stringify(config))
      throw new Error("Cleanup cancelled or schedule changed.");
  };
  const identityCheck = (): ContextTreeState => {
    check();
    const tree = resolveConnectionRecord(config.projectPath).tree;
    if (treeIdentity(tree) !== config.identity)
      throw new Error("Cleanup connection identity changed; reschedule explicitly.");
    return tree;
  };
  try {
    check();
    const lastActivity = activity(config.id);
    if (lastActivity === null || Date.now() - lastActivity > 86400000) return record("inactive");
    identityCheck();
    const synced = (dependencies.sync ?? syncProject)(config.projectPath);
    check();
    if (readState(statePath(config.id, "success")) === synced.sha) return record("unchanged", { sha: synced.sha });
    worktreePath = (dependencies.prepare ?? prepareContextWrite)(config.projectPath).worktreePath;
    check();
    const head = git(worktreePath, ["rev-parse", "HEAD"]);
    const before = snapshot(worktreePath);
    record("running");
    const editorial = readFileSync(
      resolvePackagedResource("skills", "context-tree-cleanup", "references", "editorial.md"),
      "utf8",
    );
    const monitor = setInterval(() => {
      try {
        check();
      } catch {
        controller.abort();
      }
    }, 250);
    try {
      await (dependencies.agent ?? runAgent)(
        config,
        worktreePath,
        `${editorial}\n\nYou are the editorial worker in an already prepared isolated worktree. Read all normal and member Markdown content directly using file tools. Edit and check references only. Do not invoke Context Tree lifecycle commands, stage, commit, change Git configuration, or publish. Do not follow other skills that request those operations. Report unresolved issues outside tree files.`,
        controller.signal,
      );
    } finally {
      clearInterval(monitor);
    }
    check();
    if (git(worktreePath, ["rev-parse", "HEAD"]) !== head) throw new Error("Cleanup agent committed changes.");
    const changed = inspectEdits(worktreePath, before);
    if (!verifyTree(worktreePath).ok) throw new Error("Cleanup agent produced an invalid tree.");
    identityCheck();
    if (!changed) {
      atomicState(statePath(config.id, "success"), head);
      return record("noop", { sha: head });
    }
    record("running", { message: "publishing" });
    check();
    publishing = true;
    const finished = (dependencies.finish ?? finishContextWrite)({
      projectPath: config.projectPath,
      worktreePath,
      message: "Clean up Context Tree content",
    });
    publishing = false;
    atomicState(statePath(config.id, "success"), finished.sha);
    return record("published", { sha: finished.sha });
  } catch (error) {
    const message = sanitizeCommandOutput(error instanceof Error ? error.message : "Cleanup failed.");
    const outdated = error instanceof Error && "code" in error && error.code === "WRITE_OUTDATED";
    return record(
      publishing && !outdated
        ? "publication-uncertain"
        : controller.signal.aborted || !loadSchedule(config.id).enabled
          ? "cancelled"
          : "failed",
      { message },
    );
  } finally {
    process.removeListener("SIGTERM", cancel);
    process.removeListener("SIGINT", cancel);
    rmSync(lock, { recursive: true, force: true });
  }
}
