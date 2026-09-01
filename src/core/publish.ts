import { basename } from "node:path";

import {
  CLI_ERROR_CODES,
  type ContextTreePublishResult,
  githubRepositoryIdentitySchema,
  SCHEMA_VERSION,
} from "../schemas.js";
import { resolveConnectionRecord, updateConnectionTree } from "./connections.js";
import { ContextTreeError } from "./internal/errors.js";
import { CommandError, type CommandRunner, gh, git, optionalGit } from "./internal/git.js";
import { canonicalGitHubRepositoryUrl } from "./internal/github-repository.js";

export type PublishProjectOptions = {
  /** GitHub OWNER/REPO override; defaults to the authenticated account plus the managed tree name. */
  repository?: string | undefined;
};

function authenticatedAccount(runner?: CommandRunner): string {
  let login: string;
  try {
    login = gh(["api", "user", "--jq", ".login"], { message: "GitHub account lookup failed.", runner });
  } catch (error) {
    if (
      error instanceof CommandError &&
      /gh auth login|not logged|authentication failed|http 401|bad credentials/iu.test(error.stderr)
    ) {
      throw new ContextTreeError(
        CLI_ERROR_CODES.githubAuth,
        "GitHub authentication failed; run gh auth login before publishing.",
      );
    }
    throw new ContextTreeError(
      CLI_ERROR_CODES.publishIncomplete,
      "GitHub account lookup failed; publication did not start and must not be retried automatically.",
    );
  }
  if (login.trim().length === 0) {
    throw new ContextTreeError(
      CLI_ERROR_CODES.publishIncomplete,
      "GitHub account lookup returned no repository owner.",
    );
  }
  return login.trim();
}

function classifyCreationFailure(stderr: string): ContextTreeError {
  if (/already exists/iu.test(stderr)) {
    return new ContextTreeError(
      CLI_ERROR_CODES.repositoryExists,
      "A GitHub repository with this name already exists; choose an explicit OWNER/REPO override.",
    );
  }
  return new ContextTreeError(
    CLI_ERROR_CODES.publishIncomplete,
    "GitHub repository creation has an uncertain or partial result; do not retry automatically.",
  );
}

/**
 * Publish a clean, valid local tree as a private GitHub repository. The
 * default repository name derives from the authenticated account and managed
 * tree name; OWNER/REPO is accepted only as an explicit override. The initial
 * publication is one gh repo create operation, and the stored connection is
 * updated atomically to the published tree state.
 */
export function publishProject(
  projectPath: string,
  options: PublishProjectOptions = {},
  runner?: CommandRunner,
): ContextTreePublishResult {
  const connection = resolveConnectionRecord(projectPath, runner);
  const root = connection.tree.path;
  if (connection.tree.kind === "github") {
    throw new ContextTreeError(
      CLI_ERROR_CODES.failed,
      `The Context Tree is already published as ${connection.tree.repository}; writes publish new commits automatically.`,
    );
  }
  if (optionalGit(root, ["remote", "get-url", "origin"], runner) !== undefined) {
    throw new ContextTreeError(
      CLI_ERROR_CODES.failed,
      "A local Context Tree must not already have an origin before publication.",
    );
  }
  const branch = git(root, ["symbolic-ref", "--short", "HEAD"], {
    message: "Failed to resolve the checked-out branch.",
    runner,
  });
  const sha = git(root, ["rev-parse", "HEAD"], { message: "Failed to resolve the Context Tree commit.", runner });

  const repository =
    options.repository === undefined
      ? `${authenticatedAccount(runner)}/${basename(root)}`
      : githubRepositoryIdentitySchema.parse(options.repository);
  const url = canonicalGitHubRepositoryUrl(repository);

  try {
    gh(["repo", "create", repository, "--private", "--source", root, "--remote", "origin", "--push"], {
      message: "GitHub repository creation failed.",
      runner,
    });
  } catch (error) {
    if (error instanceof CommandError) throw classifyCreationFailure(error.stderr);
    throw new ContextTreeError(CLI_ERROR_CODES.publishIncomplete, "GitHub publication ended with an uncertain result.");
  }

  try {
    updateConnectionTree(connection.projectPath, { kind: "github", path: root, repository }, runner);
  } catch {
    throw new ContextTreeError(
      CLI_ERROR_CODES.publishIncomplete,
      "The private repository was created, but updating the local connection failed.",
    );
  }
  return { branch, repository, schemaVersion: SCHEMA_VERSION, sha, url };
}
