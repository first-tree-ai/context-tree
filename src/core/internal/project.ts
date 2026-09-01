import { realpathSync } from "node:fs";
import { realDirectoryWithoutSymlinks } from "../path.js";
import type { CommandRunner } from "./git.js";
import { optionalGit } from "./git.js";

/**
 * Projects are identified solely by their canonical local root. A Git
 * repository without an origin, a non-Git directory, a Git worktree, and a
 * separate clone are all independent checkouts with their own canonical root.
 */
export function canonicalProjectRoot(path: string, runner?: CommandRunner): string {
  const directory = realDirectoryWithoutSymlinks(path, "Project path");
  const toplevel = optionalGit(directory, ["rev-parse", "--show-toplevel"], runner);
  if (toplevel === undefined || toplevel.length === 0) return directory;
  return realpathSync(toplevel);
}
