import { randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { CLI_ERROR_CODES } from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import { realDirectoryWithoutSymlinks } from "../tree/path.js";

export function privateDirectory(path: string): string {
  const absolute = resolve(path);
  if (!lstatSync(absolute, { throwIfNoEntry: false })) {
    privateDirectory(dirname(absolute));
    mkdirSync(absolute, { mode: 0o700 });
  }
  return realDirectoryWithoutSymlinks(absolute, "State directory");
}
export function stateDirectory(...segments: string[]): string {
  return privateDirectory(join(homedir(), ".context-tree", ...segments));
}
export function readState(path: string): unknown {
  realDirectoryWithoutSymlinks(dirname(path), "State parent");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("State must be a regular file.");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function atomicFile(path: string, value: string, mode: 0o600 | 0o644 | 0o700 = 0o600): void {
  realDirectoryWithoutSymlinks(dirname(path), "State parent");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("State must be a regular file.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { flag: "wx", mode });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function atomicState(path: string, value: unknown): void {
  atomicFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
/** Publish a nonempty lock directory atomically; dead owners can be reclaimed without a stale timeout. */
function acquireLock(path: string): () => void {
  realDirectoryWithoutSymlinks(dirname(path), "Lock parent");
  const candidate = `${path}.${randomUUID()}.tmp`;
  const owner = `${process.pid}.${randomUUID()}`;
  mkdirSync(candidate, { mode: 0o700 });
  writeFileSync(join(candidate, owner), "", { flag: "wx", mode: 0o600 });
  try {
    const existing = lstatSync(path, { throwIfNoEntry: false });
    if (existing) {
      if (!existing.isDirectory() || existing.isSymbolicLink()) throw new Error("Invalid lock directory.");
      const entries = readdirSync(path);
      if (entries.length === 0) removeEmptyLock(path);
      if (entries.length === 1 && /^\d+\.[a-f0-9-]+$/u.test(entries[0] ?? "")) {
        const marker = entries[0];
        const pid = Number(marker?.split(".")[0]);
        let dead = false;
        try {
          process.kill(pid, 0);
        } catch (error) {
          dead = error instanceof Error && "code" in error && error.code === "ESRCH";
        }
        if (dead && marker) {
          // Only the contender that removes this exact owner may remove the empty directory.
          // A replacement lock is nonempty, so rmdir cannot remove a new owner's lock.
          try {
            unlinkSync(join(path, marker));
            rmdirSync(path);
          } catch (error) {
            if (
              !(
                error instanceof Error &&
                "code" in error &&
                ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))
              )
            )
              throw error;
          }
        }
      }
    }
    try {
      renameSync(candidate, path);
    } catch {
      throw new ContextTreeError(CLI_ERROR_CODES.busy, `Another operation owns ${path}.`);
    }
    return () => {
      unlinkSync(join(path, owner));
      removeEmptyLock(path);
    };
  } finally {
    rmSync(candidate, { recursive: true, force: true });
  }
}

/** A released lock may already have been replaced by a nonempty lock from another process. */
function removeEmptyLock(path: string): void {
  try {
    rmdirSync(path);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && ["ENOENT", "ENOTEMPTY", "EEXIST"].includes(String(error.code))))
      throw error;
  }
}

export function withLock<T>(path: string, operation: () => T): T {
  const release = acquireLock(path);
  try {
    return operation();
  } finally {
    release();
  }
}
export async function withAsyncLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  const release = acquireLock(path);
  try {
    return await operation();
  } finally {
    release();
  }
}
