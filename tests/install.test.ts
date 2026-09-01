import { spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { installSkills } from "../src/core/install.js";

const SKILLS = [
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
];
const roots = new Set<string>();

function workspace(): string {
  const root = mkdtempSync(resolve(tmpdir(), "context-tree-install-"));
  roots.add(root);
  return root;
}

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe("skill installation", () => {
  it("installs every packaged skill for a named host below a project root", () => {
    const root = workspace();
    const result = installSkills({ hosts: ["claude"], projectPath: root });
    expect(result.installed).toHaveLength(1);
    expect(result.installed[0]?.host).toBe("claude");
    expect(result.installed[0]?.skills).toEqual(SKILLS);
    expect(result.skipped).toEqual([]);
    for (const skill of SKILLS) {
      const target = join(root, ".claude", "skills", skill, "SKILL.md");
      expect(existsSync(target), skill).toBe(true);
      expect(lstatSync(target).isFile()).toBe(true);
      expect(lstatSync(target).mode & 0o777).toBe(0o644);
    }
  });

  it("copies the Codex interface metadata alongside each skill", () => {
    const root = workspace();
    installSkills({ hosts: ["codex"], projectPath: root });
    for (const skill of SKILLS) {
      expect(existsSync(join(root, ".codex", "skills", skill, "agents", "openai.yaml")), skill).toBe(true);
    }
  });

  it("installs no launcher script, because skills now call the CLI on PATH", () => {
    const root = workspace();
    installSkills({ hosts: ["claude"], projectPath: root });
    for (const skill of SKILLS) {
      expect(existsSync(join(root, ".claude", "skills", skill, "scripts")), skill).toBe(false);
    }
  });

  it("replaces an earlier installation in place, which is the upgrade path", () => {
    const root = workspace();
    installSkills({ hosts: ["claude"], projectPath: root });
    const target = join(root, ".claude", "skills", "context-tree-read", "SKILL.md");
    writeFileSync(target, "stale\n");
    const stray = join(root, ".claude", "skills", "context-tree-read", "stray.md");
    writeFileSync(stray, "stale\n");

    installSkills({ hosts: ["claude"], projectPath: root });
    expect(readFileSync(target, "utf8")).toContain("context-tree sync");
    expect(existsSync(stray)).toBe(false);
  });

  it("never touches a skill directory the package does not own", () => {
    const root = workspace();
    const foreign = join(root, ".claude", "skills", "someone-elses-skill");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "mine\n");

    installSkills({ hosts: ["claude"], projectPath: root });
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("defaults to every host for a project install", () => {
    const root = workspace();
    const result = installSkills({ projectPath: root });
    expect(result.installed.map((entry) => entry.host).sort()).toEqual(["claude", "codex"]);
  });

  it("refuses to install through a symlinked skill directory", () => {
    const root = workspace();
    const outside = join(root, "outside");
    mkdirSync(outside);
    mkdirSync(join(root, ".claude"));
    symlinkSync(outside, join(root, ".claude", "skills"), "dir");
    expect(() => installSkills({ hosts: ["claude"], projectPath: root })).toThrow(/real directory/u);
  });
});

/**
 * The postinstall script is the only code that writes to a user's agent configuration without
 * being asked, so its guard is worth testing directly. `npm_config_global` alone is not enough:
 * npm sets it for every dependency of a global install too, so a package that merely depends on
 * Context Tree would otherwise install skills as a side effect.
 */
describe("postinstall guard", () => {
  const script = resolve(import.meta.dirname, "..", "scripts", "postinstall.mjs");

  /** Run the guard from a copy of the package placed at `packageRoot`, with an isolated home. */
  function runFrom(packageRoot: string, home: string, global: boolean): string {
    mkdirSync(join(packageRoot, "scripts"), { recursive: true });
    mkdirSync(join(packageRoot, "dist", "cli"), { recursive: true });
    writeFileSync(join(packageRoot, "scripts", "postinstall.mjs"), readFileSync(script, "utf8"));
    // Stand in for the built CLI so a permitted run reports an install without doing one.
    writeFileSync(
      join(packageRoot, "dist", "cli", "index.mjs"),
      'process.stdout.write(JSON.stringify({ installed: [{ host: "codex", path: "p", skills: ["s"] }], skipped: [] }));\n',
    );
    mkdirSync(join(home, ".codex"), { recursive: true });
    const result = spawnSync(process.execPath, [join(packageRoot, "scripts", "postinstall.mjs")], {
      encoding: "utf8",
      env: { HOME: home, PATH: process.env.PATH ?? "", ...(global ? { npm_config_global: "true" } : {}) },
    });
    return result.stdout;
  }

  it("installs only for a direct global install, never as another package's dependency", () => {
    const prefix = workspace();
    const home = workspace();

    // A direct global install: the parent of `node_modules` is npm's prefix, not a package.
    const direct = join(prefix, "lib", "node_modules", "@first-tree-ai", "context-tree");
    expect(runFrom(direct, home, true)).toContain("installed 1 skills");

    // A dependency of a global install: the parent of `node_modules` is the owning package.
    const nested = join(prefix, "lib", "node_modules", "open-tag", "node_modules", "@first-tree-ai", "context-tree");
    mkdirSync(join(prefix, "lib", "node_modules", "open-tag"), { recursive: true });
    writeFileSync(join(prefix, "lib", "node_modules", "open-tag", "package.json"), '{"name":"open-tag"}\n');
    expect(runFrom(nested, workspace(), true)).toContain("run `context-tree install`");
  });

  it("stays inert for a local install even at the top level", () => {
    const root = join(workspace(), "node_modules", "@first-tree-ai", "context-tree");
    expect(runFrom(root, workspace(), false)).toContain("run `context-tree install`");
  });
});
