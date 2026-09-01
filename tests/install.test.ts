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
