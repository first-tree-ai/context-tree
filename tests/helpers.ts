import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, vi } from "vitest";
import { type CommandRunner, defaultRunner, git } from "../src/adapters/git.js";
import { scaffoldTree } from "../src/tree/scaffold.js";

export function node(title: string): string {
  return `---\ntitle: ${JSON.stringify(title)}\n---\n\n${title}\n`;
}
export function fixture(): { home: string; project: string } {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "context-tree-redesign-")));
  const project = join(home, "project");
  mkdirSync(project);
  vi.stubEnv("HOME", home);
  vi.stubEnv("GIT_CONFIG_NOSYSTEM", "1");
  vi.stubEnv("GIT_CONFIG_GLOBAL", join(home, "gitconfig"));
  writeFileSync(
    join(home, "gitconfig"),
    "[init]\n defaultBranch = main\n[user]\n name = Test\n email = test@example.test\n[commit]\n gpgsign = false\n",
  );
  return { home, project };
}
export function useFixture(): () => { home: string; project: string } {
  let current: ReturnType<typeof fixture>;
  beforeEach(() => {
    current = fixture();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(current.home, { recursive: true, force: true });
  });
  return () => current;
}
export function commit(root: string, message = "Test commit"): string {
  git(root, ["add", "--all"]);
  git(root, ["commit", "--quiet", "-m", message]);
  return git(root, ["rev-parse", "HEAD"]);
}
export function initRepository(root: string): void {
  mkdirSync(root, { recursive: true });
  git(root, ["init", "--quiet"]);
  writeFileSync(join(root, "code.ts"), "export const value = 1;\n");
  commit(root);
}
export function remoteFixture(home: string): {
  remote: string;
  seed: string;
  runner: CommandRunner;
  calls: string[][];
} {
  const seed = join(home, "seed");
  initRepository(seed);
  scaffoldTree(join(seed, "docs"), "Docs");
  scaffoldTree(join(seed, "handbook"), "Handbook");
  commit(seed);
  const remote = join(home, "remote.git");
  git(home, ["clone", "--bare", "--quiet", seed, remote]);
  const calls: string[][] = [];
  const runner: CommandRunner = (command, args) => {
    calls.push([command, ...args]);
    const forwarded = [...args];
    const index = forwarded.indexOf("https://github.com/acme/context.git");
    if (index >= 0 && forwarded.includes("clone")) forwarded[index] = remote;
    const origin = forwarded.indexOf("origin");
    if (origin >= 0 && (forwarded.includes("fetch") || forwarded.includes("push"))) forwarded[origin] = remote;
    const result = defaultRunner(command, forwarded);
    if (index >= 0 && forwarded.includes("clone") && result.status === 0) {
      const root = forwarded.at(-1);
      if (!root) throw new Error("Missing clone destination");
      git(root, ["remote", "set-url", "origin", "https://github.com/acme/context.git"]);
    }
    return result;
  };
  return { seed, remote, runner, calls };
}
