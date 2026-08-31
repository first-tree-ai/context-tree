import { spawnSync } from "node:child_process";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

import {
  CLI_ERROR_CODES,
  type ContextTreePushResult,
  githubRepositoryIdentitySchema,
  SCHEMA_VERSION,
} from "../schemas.js";
import { canonicalGitHubRepositoryUrl, repositoryIdentityFromGitHubUrl } from "./internal/github-repository.js";
import { LinkError } from "./links.js";
import { verifyTree } from "./verify.js";

export type CommandResult = { status: number | null; stdout: string; stderr: string };
export type CommandRunner = (command: string, args: string[]) => CommandResult;

export type PushTreeOptions = {
  path: string;
  /** GitHub OWNER/REPO to create as a private repository when the tree has no origin. */
  repository?: string;
};

function defaultRunner(command: string, args: string[]): CommandResult {
  const result = spawnSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return {
    status: result.status,
    stderr: typeof result.stderr === "string" ? result.stderr : "",
    stdout: typeof result.stdout === "string" ? result.stdout : "",
  };
}

function run(runner: CommandRunner, command: string, args: string[], message: string): string {
  const result = runner(command, args);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim().length > 0 ? `${message}: ${result.stderr.trim()}` : message);
  }
  return result.stdout.replace(/\r?\n$/u, "");
}

function optionalOutput(runner: CommandRunner, command: string, args: string[]): string | undefined {
  const result = runner(command, args);
  if (result.status !== 0) return undefined;
  return result.stdout.replace(/\r?\n$/u, "");
}

function discoverRemoteDefaultBranch(runner: CommandRunner, root: string, fallback: string): string {
  const output = optionalOutput(runner, "git", ["-C", root, "ls-remote", "--symref", "origin", "HEAD"]);
  if (output === undefined) return fallback;
  const refs = output
    .split("\n")
    .map((line) => /^ref: refs\/heads\/([^\s\t]+)\tHEAD$/u.exec(line)?.[1])
    .filter((value): value is string => value !== undefined && value.length > 0);
  return refs.length === 1 ? (refs[0] ?? fallback) : fallback;
}

export function pushTree(options: PushTreeOptions, runner: CommandRunner = defaultRunner): ContextTreePushResult {
  const root = realpathSync(resolve(options.path));
  if (!verifyTree(root).ok) throw new Error("Refusing to push an invalid Context Tree; run context-tree verify.");

  const branch = run(
    runner,
    "git",
    ["-C", root, "symbolic-ref", "--short", "HEAD"],
    "Failed to resolve the current branch.",
  );
  const sha = optionalOutput(runner, "git", ["-C", root, "rev-parse", "--verify", "HEAD"]);
  if (sha === undefined) {
    throw new LinkError(CLI_ERROR_CODES.noCommits, "The Context Tree has no commits; commit before pushing.");
  }
  const porcelain = run(runner, "git", ["-C", root, "status", "--porcelain", "--untracked-files=all"], "");
  const uncommittedFiles = porcelain.split("\n").filter((line) => line.trim().length > 0).length;

  const existingOrigin = optionalOutput(runner, "git", ["-C", root, "remote", "get-url", "origin"]);
  let repositoryIdentity: string;
  let created = false;
  if (options.repository !== undefined) {
    repositoryIdentity = githubRepositoryIdentitySchema.parse(options.repository);
    if (existingOrigin === undefined) {
      run(runner, "gh", ["repo", "create", repositoryIdentity, "--private"], "GitHub repository creation failed.");
      run(
        runner,
        "git",
        ["-C", root, "remote", "add", "origin", canonicalGitHubRepositoryUrl(repositoryIdentity)],
        "Failed to configure the origin remote.",
      );
      created = true;
    } else if (repositoryIdentityFromGitHubUrl(existingOrigin).toLowerCase() !== repositoryIdentity.toLowerCase()) {
      throw new Error("The Context Tree origin already identifies a different repository.");
    }
  } else {
    if (existingOrigin === undefined) {
      throw new LinkError(
        CLI_ERROR_CODES.noRemote,
        "The Context Tree has no origin remote; pass an OWNER/REPO to create one.",
      );
    }
    repositoryIdentity = repositoryIdentityFromGitHubUrl(existingOrigin);
  }

  run(runner, "git", ["-C", root, "push", "--set-upstream", "origin", branch], "Pushing the Context Tree failed.");
  let defaultBranch: string;
  if (created) {
    run(
      runner,
      "gh",
      ["repo", "edit", repositoryIdentity, "--default-branch", branch],
      "Failed to configure the default branch.",
    );
    defaultBranch = branch;
  } else {
    defaultBranch = discoverRemoteDefaultBranch(runner, root, branch);
  }

  return {
    branch,
    defaultBranch,
    remote: { name: "origin", repository: repositoryIdentity, url: canonicalGitHubRepositoryUrl(repositoryIdentity) },
    root,
    schemaVersion: SCHEMA_VERSION,
    sha,
    uncommittedFiles,
  };
}
