import { githubRepositoryIdentitySchema } from "../../schemas.js";

export function canonicalGitHubRepositoryUrl(repository: string): string {
  githubRepositoryIdentitySchema.parse(repository);
  return `https://github.com/${repository}.git`;
}
