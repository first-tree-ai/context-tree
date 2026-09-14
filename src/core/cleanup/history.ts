import { randomUUID } from "node:crypto";
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeSync,
} from "node:fs";
import { join } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { z } from "zod";
import {
  type CleanupLogEvent,
  type CleanupLogsResult,
  type CleanupOutcome,
  type CleanupRunMetadata,
  type CleanupSchedule,
  cleanupLogEventSchema,
  cleanupLogsResultSchema,
  cleanupRunMetadataSchema,
  SCHEMA_VERSION,
} from "../../schemas.js";
import { sanitizeCommandOutput } from "../internal/git.js";
import { atomicState, cleanupRoot, privateDirectory, readState } from "./store.js";

export const MAX_LOG_BYTES = 5 * 1024 * 1024;
function directory(treeId: string): string {
  if (!/^[a-f0-9]{64}$/u.test(treeId)) throw new Error("Invalid cleanup tree ID.");
  return privateDirectory(join(cleanupRoot(), "logs", treeId));
}
function runDirectory(root: string, runId: string): string {
  z.string().uuid().parse(runId);
  const path = join(root, runId);
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) throw new Error("Unknown cleanup run ID.");
  return privateDirectory(path);
}
function summaries(root: string): CleanupRunMetadata[] {
  return readdirSync(root)
    .flatMap((id) => {
      const path = runDirectory(root, id);
      const state = readState(join(path, "metadata"));
      // Metadata is the initialization commit point. Preserve unfinished directories:
      // their writer may still be active, but they must not block history or later runs.
      if (state === undefined) return [];
      const metadata = cleanupRunMetadataSchema.parse(state);
      if (metadata.runId !== id) throw new Error("Cleanup log identity is corrupt.");
      return metadata;
    })
    .sort((a, b) => b.startedAt - a.startedAt || b.runId.localeCompare(a.runId));
}
function readEvents(path: string): CleanupLogEvent[] {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_LOG_BYTES) throw new Error("Unsafe cleanup events file.");
    // A killed writer may leave an unfinished final record.
    const lines = readFileSync(fd, "utf8").split("\n");
    lines.pop();
    return lines.map((line) => cleanupLogEventSchema.parse(JSON.parse(line)));
  } finally {
    closeSync(fd);
  }
}
export function readCleanupHistory(treeId: string, options: { list?: boolean; run?: string } = {}): CleanupLogsResult {
  if (options.list && options.run !== undefined) throw new Error("--list and --run are mutually exclusive.");
  if (options.run !== undefined) z.string().uuid().parse(options.run);
  const root = directory(treeId);
  const runs = summaries(root);
  const selected = options.list ? undefined : (options.run ?? runs[0]?.runId);
  if (options.run && !runs.some((run) => run.runId === options.run)) throw new Error("Unknown cleanup run ID.");
  return cleanupLogsResultSchema.parse({
    schemaVersion: SCHEMA_VERSION,
    runs,
    selectedRunId: selected ?? null,
    events: selected ? readEvents(join(runDirectory(root, selected), "events.jsonl")) : [],
  });
}
export function sanitizeLogText(text: string): string {
  return sanitizeCommandOutput(
    // biome-ignore lint/suspicious/noControlCharactersInRegex: remove terminal control bytes before persistence
    stripVTControlCharacters(text).replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/gu, ""),
  )
    .replace(/\b(?:https?|ssh):\/\/[^\s]+/giu, "<redacted URL>")
    .replace(/\b[A-Z_][A-Z0-9_]*=[^\s]+/gu, "<redacted assignment>");
}
export class CleanupHistory {
  readonly runId: string;
  private readonly path: string;
  private metadata: CleanupRunMetadata;
  private bytes = 0;
  private failed = false;
  constructor(config: CleanupSchedule) {
    const root = directory(config.id);
    const previous = summaries(root);
    // Incomplete runs are preserved: they may still belong to an active process.
    let count = previous.length;
    for (const run of [...previous].reverse()) {
      if (count < 50) break;
      if (!run.terminal) continue;
      rmSync(runDirectory(root, run.runId), { recursive: true });
      count--;
    }
    this.runId = randomUUID();
    this.path = privateDirectory(join(root, this.runId));
    this.metadata = {
      runId: this.runId,
      startedAt: Date.now(),
      agent: config.agent,
      ...(config.model === undefined ? {} : { model: sanitizeLogText(config.model) }),
      truncated: false,
    };
    const fd = openSync(
      join(this.path, "events.jsonl"),
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    closeSync(fd);
    atomicState(join(this.path, "metadata"), this.metadata);
  }
  event(source: CleanupLogEvent["source"], text: string): void {
    this.assertHealthy();
    try {
      if (this.metadata.truncated) return;
      const line = `${JSON.stringify(cleanupLogEventSchema.parse({ at: Date.now(), source, text: sanitizeLogText(text) }))}\n`;
      const size = Buffer.byteLength(line);
      if (this.bytes + size > MAX_LOG_BYTES) {
        this.metadata.truncated = true;
        this.save();
        return;
      }
      privateDirectory(this.path);
      const fd = openSync(
        join(this.path, "events.jsonl"),
        constants.O_APPEND | constants.O_WRONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      );
      try {
        if (!fstatSync(fd).isFile()) throw new Error("Unsafe cleanup events file.");
        const buffer = Buffer.from(line);
        let written = 0;
        while (written < buffer.length) written += writeSync(fd, buffer, written, buffer.length - written);
      } finally {
        closeSync(fd);
      }
      this.bytes += size;
    } catch {
      this.failed = true;
      throw new Error("Unable to store cleanup logs; worktree preserved.");
    }
  }
  assertHealthy(): void {
    if (this.failed) throw new Error("Unable to store cleanup logs; worktree preserved.");
  }
  finish(outcome: CleanupOutcome): void {
    // Attempt terminal metadata even if event storage failed.
    this.metadata.terminal = {
      ...outcome,
      ...(outcome.message === undefined ? {} : { message: sanitizeLogText(outcome.message) }),
    };
    this.save();
  }
  private save(): void {
    privateDirectory(this.path);
    atomicState(join(this.path, "metadata"), this.metadata);
  }
}
