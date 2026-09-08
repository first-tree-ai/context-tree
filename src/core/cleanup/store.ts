import { createHash, randomUUID } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { z } from "zod";
import { type CleanupSchedule, type ContextTreeState, cleanupScheduleSchema } from "../../schemas.js";
import { realDirectoryWithoutSymlinks } from "../path.js";

export function privateDirectory(path: string): string {
  // Check each existing parent before creating a child.
  const parent = join(path, "..");
  if (!lstatSync(path, { throwIfNoEntry: false })) {
    privateDirectory(parent);
    mkdirSync(path, { mode: 0o700 });
  }
  return realDirectoryWithoutSymlinks(path, "Cleanup directory");
}
export function cleanupRoot(): string {
  return privateDirectory(join(realpathSync(homedir()), ".context-tree", "cleanup"));
}
export function statePath(id: string, name: string): string {
  if (!/^[a-f0-9]{64}$/u.test(id) || !/^[a-z-]+$/u.test(name)) throw new Error("Invalid cleanup state key.");
  return join(cleanupRoot(), `${id}.${name}`);
}
export function readState(path: string): unknown {
  const parent = lstatSync(dirname(path), { throwIfNoEntry: false });
  if (!parent) return undefined;
  realDirectoryWithoutSymlinks(dirname(path), "Cleanup state parent");
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (!entry) return undefined;
  if (!entry.isFile() || entry.isSymbolicLink()) throw new Error("Cleanup state must be a regular file.");
  return JSON.parse(readFileSync(path, "utf8"));
}
export function atomicState(path: string, value: unknown): void {
  atomicFile(path, `${JSON.stringify(value)}\n`);
}
export function atomicFile(path: string, value: string): void {
  const entry = lstatSync(path, { throwIfNoEntry: false });
  if (entry && (!entry.isFile() || entry.isSymbolicLink())) throw new Error("Unsafe cleanup file.");
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, value, { mode: 0o600, flag: "wx" });
  try {
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
export function treeIdentity(tree: ContextTreeState): string {
  return tree.kind === "github" ? `github:${tree.repository.toLowerCase()}` : `local:${realpathSync(tree.path)}`;
}
export function identityId(identity: string): string {
  return createHash("sha256").update(identity).digest("hex");
}
export function schedules(): CleanupSchedule[] {
  return readdirSync(cleanupRoot())
    .filter((name) => name.endsWith(".config"))
    .map((name) => loadSchedule(name.slice(0, -".config".length)));
}
export function loadSchedule(id: string): CleanupSchedule {
  const config = cleanupScheduleSchema.parse(readState(statePath(id, "config")));
  if (config.id !== id || identityId(config.identity) !== id) throw new Error("Cleanup identity is corrupt.");
  return config;
}
export function activity(id: string): number | null {
  const parsed = z
    .number()
    .finite()
    .safeParse(readState(statePath(id, "activity")));
  return parsed.success ? parsed.data : null;
}
