import { type CommandRunner, git } from "../adapters/git.js";
import { withLockWait } from "../adapters/state.js";

export function addManagedWorktree(
  repository: { root: string; sha: string },
  root: string,
  directory: string,
  branch?: string,
  runner?: CommandRunner,
): void {
  withLockWait(`${repository.root}.lock`, () => {
    const sparse = directory !== ".";
    if (sparse) {
      const version = /^git version (\d+)\.(\d+)/u.exec(git(repository.root, ["version"], { runner }));
      const major = Number(version?.[1]);
      const minor = Number(version?.[2]);
      if (!(major > 2 || (major === 2 && minor >= 36)))
        throw new Error("Managed Git subtrees require Git 2.36 or newer.");
    }
    git(
      repository.root,
      [
        "worktree",
        "add",
        "--quiet",
        ...(sparse ? ["--no-checkout"] : []),
        ...(branch ? ["-b", branch] : ["--detach"]),
        root,
        repository.sha,
      ],
      { runner },
    );
    if (sparse) {
      git(
        root,
        ["sparse-checkout", "set", "--no-cone", "--no-sparse-index", "--skip-checks", "--", subtreePattern(directory)],
        { runner },
      );
      git(root, ["read-tree", "-mu", "HEAD"], { runner });
    }
  });
}

/** An anchored, literal sparse pattern that materializes exactly one subtree and nothing beside it. */
export function subtreePattern(directory: string): string {
  return `/${directory.replace(/[\\*?[\]]/gu, "\\$&")}/`;
}
