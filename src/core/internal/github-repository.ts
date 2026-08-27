import { credentialFreeRepositoryUrlSchema, githubRepositoryIdentitySchema } from "../../schemas.js";

export function parseGitHubRepositoryIdentity(repository: string): string {
  githubRepositoryIdentitySchema.parse(repository);
  return repository.split("/")[1] ?? "";
}

export function repositoryIdentityFromGitHubUrl(repositoryUrl: string): string {
  try {
    credentialFreeRepositoryUrlSchema.parse(repositoryUrl);
  } catch {
    throw new Error("Context Tree origin must be a safe credential-free github.com repository URL.");
  }
  let host: string;
  let path: string;
  const scp = /^(?:git@)?([^:]+):(.+)$/u.exec(repositoryUrl);
  if (scp !== null && !repositoryUrl.includes("://")) {
    host = scp[1] ?? "";
    path = scp[2] ?? "";
  } else {
    let parsed: URL;
    try {
      parsed = new URL(repositoryUrl);
    } catch {
      throw new Error("Context Tree origin must be a safe credential-free github.com repository URL.");
    }
    if (parsed.password || ((parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username)) {
      throw new Error("Context Tree origin must be a safe credential-free github.com repository URL.");
    }
    host = parsed.hostname;
    path = parsed.pathname;
  }
  if (host.toLowerCase() !== "github.com") {
    throw new Error("Context Tree origin must use github.com.");
  }
  const identity = path.replace(/^\/+|\/+$/gu, "").replace(/\.git$/iu, "");
  try {
    parseGitHubRepositoryIdentity(identity);
  } catch {
    throw new Error("Context Tree origin must identify a safe GitHub OWNER/REPO repository.");
  }
  return identity;
}

export function canonicalGitHubRepositoryUrl(repository: string): string {
  parseGitHubRepositoryIdentity(repository);
  return `https://github.com/${repository}.git`;
}
