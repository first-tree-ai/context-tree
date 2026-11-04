import { lstatSync, realpathSync, utimesSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, relative, sep } from "node:path";
import { type CommandRunner, git, gitRaw, optionalGit } from "../adapters/git.js";
import { stateDirectory, withLock } from "../adapters/state.js";

/** A superseded snapshot stays at its path for at least this long after its last use. */
export const SNAPSHOT_RETENTION_MS = 24 * 60 * 60 * 1000;

const SNAPSHOT_NAME = /^[a-f0-9]{64}-[a-f0-9]{40,64}$/u;

/** Record a use; eviction measures idleness from the snapshot directory's modification time. */
export function touchSnapshot(root: string, now: Date = new Date()): void {
  utimesSync(root, now, now);
}

/** Record a use when an explicit content root lies inside a managed snapshot; other paths are ignored. */
export function touchSnapshotContaining(path: string, now: Date = new Date()): void {
  try {
    const parent = realpathSync(join(homedir(), ".context-tree", "snapshots"));
    const inside = relative(parent, realpathSync(path));
    const name = inside.split(sep)[0] ?? "";
    if (!inside || inside.startsWith("..") || !SNAPSHOT_NAME.test(name)) return;
    touchSnapshot(join(parent, name), now);
  } catch {
    // Missing state or an unreadable path records no use; the read itself reports real errors.
  }
}

/**
 * Remove snapshots of one repository cache that are idle past the retention window.
 *
 * Only clean detached worktrees directly inside the snapshot directory are candidates.
 * The current snapshot, write-session worktrees, locked snapshots, and modified snapshots
 * are never removed. Eviction is best effort: any failure leaves that snapshot in place.
 * An evicted snapshot is recreated at the same path from the bare cache when resolved again.
 */
export function evictIdleSnapshots(
  repository: { root: string },
  current: string,
  runner?: CommandRunner,
  now: number = Date.now(),
): string[] {
  const parent = realpathSync(stateDirectory("snapshots"));
  const keep = realpathSync(current);
  const listed = optionalGit(repository.root, ["worktree", "list", "--porcelain", "-z"], runner);
  if (listed === undefined) return [];
  const evicted: string[] = [];
  let removed = false;
  for (const record of listed.split("\0\0")) {
    const fields = record.split("\0");
    const path = fields.find((field) => field.startsWith("worktree "))?.slice("worktree ".length);
    if (!path || !fields.includes("detached") || fields.some((field) => field.startsWith("locked"))) continue;
    if (!SNAPSHOT_NAME.test(basename(path))) continue;
    const entry = lstatSync(path, { throwIfNoEntry: false });
    if (!entry) {
      removed = true;
      continue;
    }
    if (!entry.isDirectory() || entry.isSymbolicLink() || now - entry.mtimeMs < SNAPSHOT_RETENTION_MS) continue;
    try {
      const real = realpathSync(path);
      if (dirname(real) !== parent || real === keep) continue;
      // The snapshot lock excludes a concurrent resolve of this exact snapshot. The repository
      // lock is not taken so eviction never makes a concurrent snapshot creation report busy.
      withLock(`${path}.lock`, () => {
        // A resolve that finished just before this lock was taken has refreshed the use time.
        const latest = lstatSync(path, { throwIfNoEntry: false });
        if (!latest || now - latest.mtimeMs < SNAPSHOT_RETENTION_MS) return;
        // `worktree remove` without --force also refuses modified or untracked content.
        if (gitRaw(path, ["status", "--porcelain", "--untracked-files=all", "--ignored"], { runner }).length) return;
        git(repository.root, ["worktree", "remove", "--", path], { runner });
        evicted.push(path);
      });
    } catch {
      // A busy, modified, or unreadable snapshot is preserved.
    }
  }
  // Registrations whose directory was deleted by hand are cleared; Git skips worktrees still being added.
  if (removed) optionalGit(repository.root, ["worktree", "prune"], runner);
  return evicted;
}
