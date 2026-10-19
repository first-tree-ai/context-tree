import { randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
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
/** Locks protect the complete read/modify/write operation, not only the final rename. */
export function withLock<T>(path: string, operation: () => T): T {
  realDirectoryWithoutSymlinks(dirname(path), "Lock parent");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new ContextTreeError(CLI_ERROR_CODES.busy, `Another operation owns ${path}.`);
  }
  try {
    return operation();
  } finally {
    rmSync(path, { recursive: true });
  }
}

export async function withAsyncLock<T>(path: string, operation: () => Promise<T>): Promise<T> {
  realDirectoryWithoutSymlinks(dirname(path), "Lock parent");
  try {
    mkdirSync(path, { mode: 0o700 });
  } catch {
    throw new ContextTreeError(CLI_ERROR_CODES.busy, `Another operation owns ${path}.`);
  }
  try {
    return await operation();
  } finally {
    rmSync(path, { recursive: true });
  }
}
