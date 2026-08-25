export function parseGitHubRepositoryIdentity(repository: string): string {
  const repositoryParts = repository.split("/");
  const [owner, name] = repositoryParts;
  if (
    repositoryParts.length !== 2 ||
    owner === undefined ||
    name === undefined ||
    !/^[A-Za-z\d](?:[A-Za-z\d-]{0,37}[A-Za-z\d])?$/u.test(owner) ||
    !/^[A-Za-z\d._-]{1,100}$/u.test(name) ||
    name === "." ||
    name === ".." ||
    /\.git$/iu.test(name)
  ) {
    throw new Error("Repository must be an explicit GitHub OWNER/REPO identity.");
  }
  return name;
}
