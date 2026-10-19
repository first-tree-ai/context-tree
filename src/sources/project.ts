import { lstatSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CommandRunner } from "../adapters/git.js";
import { optionalGit } from "../adapters/git.js";
import { realDirectoryWithoutSymlinks } from "../tree/path.js";

export const CONFIG_FILE = ".context-tree.json";

/** The nearest declaration wins; discovery never crosses the current Git checkout. */
export function projectRoot(path: string, runner?: CommandRunner): string {
  const start = realDirectoryWithoutSymlinks(path, "Project path");
  const gitRoot = optionalGit(start, ["rev-parse", "--show-toplevel"], runner);
  const boundary = gitRoot ? realpathSync(gitRoot) : undefined;
  let current = start;
  while (true) {
    if (lstatSync(join(current, CONFIG_FILE), { throwIfNoEntry: false })) return current;
    if (current === boundary || dirname(current) === current) break;
    current = dirname(current);
  }
  return boundary ?? start;
}
