import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { installSkills, uninstallSkills } from "../src/adapters/install.js";

const SKILL_ROOT = resolve(import.meta.dirname, "../skills");
const SKILLS = readdirSync(SKILL_ROOT).sort();
const roots = new Set<string>();

function workspace(): string {
  const root = mkdtempSync(resolve(tmpdir(), "context-tree-install-"));
  roots.add(root);
  return root;
}

afterEach(() => {
  vi.unstubAllEnvs();
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe("skill installation", () => {
  it.each([".codex", "codex-home"])("detects custom CODEX_HOME %s but installs into account HOME", (name) => {
    const home = realpathSync(workspace());
    const customRoot = workspace();
    const codexHome = join(customRoot, name);
    mkdirSync(codexHome);
    vi.stubEnv("HOME", home);
    vi.stubEnv("CODEX_HOME", codexHome);

    const result = installSkills({ hosts: ["codex"] });

    expect(result.installed).toEqual([{ host: "codex", path: join(home, ".agents", "skills"), skills: SKILLS }]);
    expect(result.skipped).toEqual([]);
    expect(existsSync(join(home, ".codex"))).toBe(false);
    expect(existsSync(join(customRoot, ".agents"))).toBe(false);
    expect(existsSync(join(codexHome, "skills"))).toBe(false);
    expect(existsSync(join(home, ".agents", "skills", "context-tree-read", "SKILL.md"))).toBe(true);
  });

  it.each(["missing", "file", "symlink"])("skips a %s CODEX_HOME even when the default exists", (kind) => {
    const home = workspace();
    const codexHome = join(home, "custom-codex");
    mkdirSync(join(home, ".codex"));
    if (kind === "file") writeFileSync(codexHome, "not a directory");
    if (kind === "symlink") symlinkSync(join(home, ".codex"), codexHome, "dir");
    vi.stubEnv("HOME", home);
    vi.stubEnv("CODEX_HOME", codexHome);

    const result = installSkills({ hosts: ["codex"] });

    expect(result.installed).toEqual([]);
    expect(result.skipped).toEqual([{ host: "codex", reason: expect.stringContaining(codexHome) }]);
    expect(existsSync(join(home, ".agents"))).toBe(false);
  });

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

  it("installs the shared .agents directory once for codex and pi", () => {
    const root = workspace();
    const result = installSkills({ hosts: ["codex", "pi"], projectPath: root });
    expect(result.installed.map((entry) => entry.host)).toEqual(["codex", "pi"]);
    expect(result.installed.map((entry) => entry.path)).toEqual([
      join(root, ".agents", "skills"),
      join(root, ".agents", "skills"),
    ]);
    expect(existsSync(join(root, ".codex"))).toBe(false);
    for (const skill of SKILLS)
      expect(readFileSync(join(root, ".agents/skills", skill, "agents/openai.yaml"), "utf8")).toBe(
        readFileSync(join(SKILL_ROOT, skill, "agents/openai.yaml"), "utf8"),
      );
    for (const skill of SKILLS) {
      expect(existsSync(join(root, ".agents", "skills", skill, "SKILL.md")), skill).toBe(true);
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
    expect(readFileSync(target, "utf8")).toBe(readFileSync(join(SKILL_ROOT, "context-tree-read/SKILL.md"), "utf8"));
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
    expect(result.installed.map((entry) => entry.host).sort()).toEqual(["claude", "codex", "pi"]);
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
  it("removes owned skills while preserving foreign skills and state", () => {
    const root = workspace();
    const owned = join(root, ".claude", "skills", "context-tree-custom");
    mkdirSync(owned, { recursive: true });
    const foreign = join(root, ".claude/skills/foreign");
    mkdirSync(foreign);
    writeFileSync(join(foreign, "SKILL.md"), "keep");
    const state = join(root, ".context-tree");
    mkdirSync(state);

    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(result.removed[0]?.skills).toEqual(["context-tree-custom"]);
    expect(existsSync(owned)).toBe(false);
    expect(readFileSync(join(foreign, "SKILL.md"), "utf8")).toBe("keep");
    expect(existsSync(state)).toBe(true);
  });

  it("reports nothing to remove for a host that is not installed", () => {
    const root = workspace();
    const result = uninstallSkills({ hosts: ["claude"], projectPath: root });
    expect(result.removed).toEqual([]);
    expect(result.skipped).toEqual([expect.objectContaining({ host: "claude" })]);
    expect(existsSync(join(root, ".claude"))).toBe(false);
  });

  it("is idempotent", () => {
    const root = workspace();
    installSkills({ hosts: ["claude"], projectPath: root });
    uninstallSkills({ hosts: ["claude"], projectPath: root });

    expect(() => uninstallSkills({ hosts: ["claude"], projectPath: root })).not.toThrow();
    expect(uninstallSkills({ hosts: ["claude"], projectPath: root }).removed[0]?.skills).toEqual([]);
  });

  it("removes the shared .agents directory once for codex and pi", () => {
    const root = workspace();
    installSkills({ hosts: ["codex", "pi"], projectPath: root });

    const result = uninstallSkills({ hosts: ["codex", "pi"], projectPath: root });

    expect(result.removed).toEqual([
      { host: "codex", path: join(root, ".agents", "skills"), skills: SKILLS },
      { host: "pi", path: join(root, ".agents", "skills"), skills: SKILLS },
    ]);
    for (const skill of SKILLS) expect(existsSync(join(root, ".agents", "skills", skill))).toBe(false);
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

it("removes obsolete owned skills without traversing symlink targets", () => {
  const root = workspace();
  const skills = join(root, ".claude/skills");
  mkdirSync(join(skills, "context-tree-setup"), { recursive: true });
  const outside = join(root, "outside");
  mkdirSync(outside);
  writeFileSync(join(outside, "keep"), "keep");
  symlinkSync(outside, join(skills, "context-tree-obsolete"));
  installSkills({ hosts: ["claude"], projectPath: root });
  expect(existsSync(join(skills, "context-tree-setup"))).toBe(false);
  expect(existsSync(join(skills, "context-tree-obsolete"))).toBe(false);
  expect(readFileSync(join(outside, "keep"), "utf8")).toBe("keep");
});
