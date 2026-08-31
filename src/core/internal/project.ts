import { lstatSync, realpathSync } from "node:fs";
import { resolve } from "node:path";

import { optionalGit } from "./git.js";

/**
 * Projects are identified solely by their canonical local root. A Git
 * repository without an origin, a non-Git directory, a Git worktree, and a
 * separate clone are all independent checkouts with their own canonical root.
 */
export function canonicalProjectRoot(path: string): string {
  const absolute = resolve(path);
  const entry = lstatSync(absolute);
  if (entry.isSymbolicLink() || !entry.isDirectory()) {
    throw new Error("Project path must be a real directory.");
  }
  const directory = realpathSync(absolute);
  const toplevel = optionalGit(directory, ["rev-parse", "--show-toplevel"]);
  if (toplevel === undefined || toplevel.length === 0) return directory;
  return realpathSync(toplevel);
}
