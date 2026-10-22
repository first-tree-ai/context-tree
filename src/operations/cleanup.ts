import { accessSync, constants, lstatSync, readFileSync, realpathSync } from "node:fs";
import { delimiter, join, relative, resolve } from "node:path";
import { runAgent } from "../adapters/agent.js";
import { cleanupRoot, loadSchedule, schedules, statePath } from "../adapters/cleanup-state.js";
import { type CommandRunner, git, sanitizeCommandOutput } from "../adapters/git.js";
import { CleanupHistory, readCleanupHistory } from "../adapters/history.js";
import { resolvePackagedResource } from "../adapters/package.js";
import { type CleanupScheduler, nativeScheduler } from "../adapters/scheduler.js";
import { atomicState, readState, withAsyncLock, withLock } from "../adapters/state.js";
import {
  type CleanupLogsResult,
  type CleanupOutcome,
  type CleanupResult,
  type CleanupSchedule,
  cleanupOutcomeSchema,
  cleanupScheduleSchema,
  SCHEMA_VERSION,
} from "../contracts/index.js";
import { connectionIdentity, identityId, selectSource, sourceSelector } from "../sources/identity.js";
import { projectRoot } from "../sources/project.js";
import { resolveSource } from "../sources/resolve.js";
import { classifyContextContent } from "../tree/content-class.js";
import { connection } from "./connections.js";
import { abortWrite, changedPaths, finishWrite, prepareWrite } from "./write.js";

export function parseCleanupInterval(value: string): number {
  const match = /^(\d+)(m|h|d)$/u.exec(value);
  const minutes = Number(match?.[1]) * (match?.[2] === "d" ? 1440 : match?.[2] === "h" ? 60 : 1);
  if (!match || !Number.isSafeInteger(minutes) || minutes < 1 || minutes > 525600)
    throw new Error("Use a whole-minute interval from 1m to 365d.");
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
      /* Try the next PATH entry. */
    }
  }
  throw new Error(`Install ${name} on PATH before scheduling cleanup.`);
}
function findSchedule(project: string, selector?: string): CleanupSchedule | undefined {
  const root = projectRoot(project);
  return selectSource(
    root,
    schedules().filter((schedule) => schedule.projectPath === root),
    selector,
  );
}
export function cleanupStatus(
  project: string,
  selector?: string,
  scheduler: CleanupScheduler = nativeScheduler(),
): CleanupResult {
  const config = findSchedule(project, selector);
  const latest = config ? readState(statePath(config.id, "latest")) : undefined;
  return {
    schemaVersion: SCHEMA_VERSION,
    schedule: config ?? null,
    ...(config ? scheduler.status(config) : { registered: false, running: false }),
    latest: latest === undefined ? null : cleanupOutcomeSchema.parse(latest),
  };
}
export function scheduleCleanup(
  options: { projectPath: string; tree?: string; agent: string; model?: string; every: string; publish: boolean },
  scheduler: CleanupScheduler = nativeScheduler(),
  runner?: CommandRunner,
): CleanupResult {
  return withLock(join(cleanupRoot(), ".management-lock"), () => {
    const selected = connection(options.projectPath, options.tree, runner);
    const resolved = resolveSource(selected, true, runner);
    if (!resolved.repository || resolved.repository.sha === "unborn")
      throw new Error("Scheduled cleanup requires a committed Git repository.");
    if (options.publish && selected.source.kind !== "git")
      throw new Error("Directory cleanup produces a review branch; only managed Git sources support --publish.");
    const identity = JSON.stringify([connectionIdentity(selected), resolved.repository.branch]);
    const id = identityId(identity);
    const owner = schedules().find((schedule) => schedule.id === id);
    if (owner && owner.projectPath !== selected.projectRoot)
      throw new Error("This source already has a cleanup schedule in another project connection.");
    const previous = findSchedule(selected.projectRoot, sourceSelector(selected.projectRoot, selected.source));
    if (previous && previous.id !== id)
      throw new Error("Remove the prior schedule before changing its source or branch.");
    const config = cleanupScheduleSchema.parse({
      schemaVersion: SCHEMA_VERSION,
      id,
      identity,
      projectPath: selected.projectRoot,
      source: selected.source,
      agent: options.agent,
      model: options.model,
      everyMinutes: parseCleanupInterval(options.every),
      nodePath: process.execPath,
      cliPath: resolvePackagedResource("dist", "cli", "index.mjs"),
      agentPath: executable(options.agent),
      searchPath: process.env.PATH ?? "",
      publish: options.publish,
      enabled: true,
    });
    atomicState(statePath(id, "config"), config);
    scheduler.install(config);
    return cleanupStatus(selected.projectRoot, sourceSelector(selected.projectRoot, selected.source), scheduler);
  });
}
export function removeCleanup(
  project: string,
  selector?: string,
  scheduler: CleanupScheduler = nativeScheduler(),
): CleanupResult {
  return withLock(join(cleanupRoot(), ".management-lock"), () => {
    const config = findSchedule(project, selector);
    if (config) {
      atomicState(statePath(config.id, "config"), { ...config, enabled: false });
      scheduler.remove(config);
    }
    return cleanupStatus(project, selector, scheduler);
  });
}
export function cleanupLogs(
  project: string,
  options: { tree?: string; list?: boolean; run?: string },
): CleanupLogsResult {
  const config = findSchedule(project, options.tree);
  if (!config) throw new Error("No cleanup schedule.");
  return readCleanupHistory(config.id, options);
}
export async function runCleanup(
  project: string,
  selector?: string,
  scheduleId?: string,
  dependencies: { agent?: typeof runAgent; runner?: CommandRunner } = {},
): Promise<CleanupOutcome> {
  const config = scheduleId ? loadSchedule(scheduleId) : findSchedule(project, selector);
  if (!config) throw new Error("No cleanup schedule.");
  return withAsyncLock(statePath(config.id, "lock"), async () => {
    const history = new CleanupHistory(config);
    const controller = new AbortController();
    const cancel = (): void => controller.abort();
    process.on("SIGTERM", cancel);
    process.on("SIGINT", cancel);
    let session: ReturnType<typeof prepareWrite> | undefined;
    let publishing = false;
    const record = (outcome: CleanupOutcome["outcome"], extra: Partial<CleanupOutcome> = {}): CleanupOutcome => {
      const result: CleanupOutcome = {
        at: Date.now(),
        runId: history.runId,
        outcome,
        ...(session ? { sessionId: session.id, worktreePath: session.treeRoot } : {}),
        ...extra,
      };
      atomicState(statePath(config.id, "latest"), result);
      history.finish(result);
      return result;
    };
    const check = (): void => {
      if (controller.signal.aborted || JSON.stringify(loadSchedule(config.id)) !== JSON.stringify(config))
        throw new Error("Cleanup cancelled or schedule changed.");
      const selected = connection(
        config.projectPath,
        sourceSelector(config.projectPath, config.source),
        dependencies.runner,
      );
      const resolved = resolveSource(selected, false, dependencies.runner);
      if (JSON.stringify([connectionIdentity(selected), resolved.repository?.branch]) !== config.identity)
        throw new Error("Cleanup source or branch changed; reschedule explicitly.");
    };
    try {
      if (!config.enabled) return record("inactive");
      check();
      session = prepareWrite(
        config.projectPath,
        sourceSelector(config.projectPath, config.source),
        dependencies.runner,
      );
      const digest = git(
        session.worktreeRoot,
        ["rev-parse", session.repository.directory === "." ? "HEAD^{tree}" : `HEAD:${session.repository.directory}`],
        { runner: dependencies.runner },
      );
      if (readState(statePath(config.id, "success")) === digest) {
        abortWrite(session.id, dependencies.runner);
        session = undefined;
        return record("unchanged");
      }
      atomicState(statePath(config.id, "latest"), {
        at: Date.now(),
        outcome: "running",
        sessionId: session.id,
        worktreePath: session.treeRoot,
      });
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
      }, 1000);
      try {
        await (dependencies.agent ?? runAgent)(
          config,
          session.treeRoot,
          `${editorial}\n\nEdit only this tree directory. Do not stage, commit, publish, or invoke lifecycle commands. Report unresolved issues outside tree files.`,
          controller.signal,
          undefined,
          (source, text) => history.event(source, text),
        );
      } finally {
        clearInterval(monitor);
      }
      history.assertHealthy();
      check();
      for (const path of changedPaths(session.worktreeRoot, dependencies.runner)) {
        const absolute = join(session.worktreeRoot, path);
        const name = relative(session.treeRoot, absolute);
        const entry = lstatSync(absolute, { throwIfNoEntry: false });
        if (
          name.startsWith("..") ||
          !name.endsWith(".md") ||
          classifyContextContent(name) === "repo-infra" ||
          (entry && (!entry.isFile() || entry.isSymbolicLink()))
        )
          throw new Error("Cleanup changed infrastructure or content outside the tree.");
      }
      publishing = config.publish;
      const finished = finishWrite(session.id, "Clean up Context Tree content", config.publish, dependencies.runner);
      atomicState(statePath(config.id, "success"), digest);
      const outcome =
        finished.outcome === "unchanged" ? "noop" : finished.outcome === "published" ? "published" : "committed";
      if (!finished.sessionId) session = undefined;
      return record(outcome, finished.sha ? { sha: finished.sha } : {});
    } catch (error) {
      return record(controller.signal.aborted ? "cancelled" : publishing ? "publication-uncertain" : "failed", {
        message: sanitizeCommandOutput(error instanceof Error ? error.message : "Cleanup failed."),
      });
    } finally {
      process.removeListener("SIGTERM", cancel);
      process.removeListener("SIGINT", cancel);
    }
  });
}
