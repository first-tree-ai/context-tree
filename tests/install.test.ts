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
import { installSkills, uninstallSkills } from "../src/core/install.js";

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

describe("skill removal", () => {
  it("removes every packaged skill it installed for a named host", () => {
    const root = workspace();
    installSkills({ hosts: ["claude"], projectPath: root });

    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(result.removed).toEqual([{ host: "claude", path: join(root, ".claude", "skills"), skills: SKILLS }]);
    expect(result.skipped).toEqual([]);
    for (const skill of SKILLS) expect(existsSync(join(root, ".claude", "skills", skill))).toBe(false);
  });

  it("removes a context-tree- skill it did not install", () => {
    const root = workspace();
    const owned = join(root, ".claude", "skills", "context-tree-custom");
    mkdirSync(owned, { recursive: true });

    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(result.removed[0]?.skills).toEqual(["context-tree-custom"]);
    expect(existsSync(owned)).toBe(false);
  });

  it("never touches a skill directory the package does not own", () => {
    const root = workspace();
    const foreign = join(root, ".claude", "skills", "someone-elses-skill");
    mkdirSync(foreign, { recursive: true });
    writeFileSync(join(foreign, "SKILL.md"), "mine\n");

    uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("mine\n");
  });

  it("reports nothing to remove for a host that is not installed", () => {
    const root = workspace();
    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });
    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toBe(`${join(root, ".claude")} does not exist; nothing to remove.`);
  });

  it("is idempotent", () => {
    const root = workspace();
    installSkills({ hosts: ["claude"], projectPath: root });
    uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(() => uninstallSkills({ hosts: ["claude"], projectPath: root })).not.toThrow();
    expect(uninstallSkills({ hosts: ["claude"], projectPath: root }).removed[0]?.skills).toEqual([]);
  });

  it("leaves everything outside the host skills directory alone", () => {
    const root = workspace();
    const state = join(root, ".context-tree", "trees", "mine");
    mkdirSync(state, { recursive: true });
    installSkills({ hosts: ["claude"], projectPath: root });

    uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(existsSync(state)).toBe(true);
  });

  it("refuses to remove through a symlinked skills directory", () => {
    const root = workspace();
    const outside = join(root, "outside");
    const owned = join(outside, "context-tree-read");
    mkdirSync(owned, { recursive: true });
    mkdirSync(join(root, ".claude"));
    symlinkSync(outside, join(root, ".claude", "skills"), "dir");

    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(result.removed).toEqual([]);
    expect(result.skipped[0]?.reason).toContain("is not a real directory");
    expect(existsSync(owned)).toBe(true);
  });
});
