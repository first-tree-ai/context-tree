import { credentialFreeRepositoryUrlSchema, githubRepositoryIdentitySchema } from "../../schemas.js";

const ORIGIN_MESSAGE = "Context Tree origin must identify a credential-free GitHub OWNER/REPO repository.";

export function canonicalGitHubRepositoryUrl(repository: string): string {
  githubRepositoryIdentitySchema.parse(repository);
  return `https://github.com/${repository}.git`;
}

/** Derive OWNER/REPO from a github.com origin, rejecting anything else. */
export function gitHubRepositoryFromOriginUrl(origin: string): string {
  if (!credentialFreeRepositoryUrlSchema.safeParse(origin).success) throw new Error(ORIGIN_MESSAGE);

  let owner: string | undefined;
  let name: string | undefined;
  const scp = /^(?:git@)?github\.com:([^/]+)\/(.+)$/iu.exec(origin);
  if (scp !== null) {
    [, owner, name] = scp;
  } else {
    const url = URL.parse(origin);
    if (url === null || url.hostname.toLowerCase() !== "github.com") throw new Error(ORIGIN_MESSAGE);
    [owner, name] = url.pathname.replace(/^\/+|\/+$/gu, "").split("/");
  }

  const repository = `${owner ?? ""}/${(name ?? "").replace(/\.git$/iu, "")}`;
  if (!githubRepositoryIdentitySchema.safeParse(repository).success) throw new Error(ORIGIN_MESSAGE);
  return repository;
}
