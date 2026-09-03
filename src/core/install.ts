import { chmodSync, copyFileSync, lstatSync, mkdirSync, readdirSync, realpathSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

import {
  type InstallSkillsResult,
  SCHEMA_VERSION,
  SKILL_HOSTS,
  type SkillHost,
  type SkillInstallation,
  type SkillInstallSkip,
  type UninstallSkillsResult,
} from "../schemas.js";
import { readPackageVersion, resolvePackagedResource } from "./internal/packaged-resource.js";

/** Per-host configuration directory, relative to the home directory or to a project root. */
const HOST_CONFIG_DIRECTORY: Record<SkillHost, string> = {
  claude: ".claude",
  codex: ".codex",
};

/** Every supported host keeps user skills in the same subdirectory of its configuration directory. */
const SKILLS_DIRECTORY = "skills";

/** Only directories carrying this prefix are ever replaced or removed. */
const OWNED_SKILL_PREFIX = "context-tree-";

export type InstallSkillsOptions = {
  /** Restrict installation to these hosts; defaults to every known host. */
  hosts?: readonly SkillHost[];
  /** Install below this project root instead of the home directory. */
  projectPath?: string;
};

export type UninstallSkillsOptions = {
  /** Restrict removal to these hosts; defaults to every known host. */
  hosts?: readonly SkillHost[];
  /** Remove below this project root instead of the home directory. */
  projectPath?: string;
};

function realHome(): string {
  try {
    return realpathSync(homedir());
  } catch {
    return homedir();
  }
}

/** Create a directory below `root`, failing closed on symlinks and non-directories. */
function ensureRealDirectory(root: string, segments: readonly string[]): string {
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    const entry = lstatSync(current, { throwIfNoEntry: false });
    if (entry === undefined) {
      mkdirSync(current, { mode: 0o700 });
      continue;
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) {
      throw new Error(`Context Tree skill directory must be a real directory: ${current}`);
    }
  }
  return current;
}

/** Copy a packaged skill tree, refusing to read or write through symlinks. Skills are never executable. */
function copyRealTree(source: string, destination: string): void {
  const entry = lstatSync(source);
  if (entry.isSymbolicLink()) throw new Error(`Refusing to install a symlinked skill entry: ${source}`);
  if (entry.isDirectory()) {
    mkdirSync(destination, { mode: 0o700, recursive: true });
    for (const child of readdirSync(source)) copyRealTree(join(source, child), join(destination, child));
    return;
  }
  if (!entry.isFile()) throw new Error(`Refusing to install a non-regular skill entry: ${source}`);
  copyFileSync(source, destination);
  chmodSync(destination, 0o644);
}

/** Packaged skill directory names, e.g. `context-tree-read`. */
function packagedSkillNames(skillsRoot: string): string[] {
  return readdirSync(skillsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(OWNED_SKILL_PREFIX))
    .map((entry) => entry.name)
    .sort();
}

/** Resolve one host's destination, or the reason it was skipped. */
function hostDestination(
  host: SkillHost,
  root: string,
  isProjectInstall: boolean,
): { destination: string } | { reason: string } {
  const configDirectory = HOST_CONFIG_DIRECTORY[host];
  if (!isProjectInstall) {
    // Home installs only target hosts the user already has, so installing the CLI never
    // creates a configuration directory for an agent that is not present.
    const hostRoot = join(root, configDirectory);
    const entry = lstatSync(hostRoot, { throwIfNoEntry: false });
    if (entry === undefined) {
      return { reason: `${hostRoot} does not exist; install ${host} first, then run context-tree install.` };
    }
    if (entry.isSymbolicLink() || !entry.isDirectory()) return { reason: `${hostRoot} is not a real directory.` };
  }
  return { destination: ensureRealDirectory(root, [configDirectory, SKILLS_DIRECTORY]) };
}

/** Resolve one host's existing skills root without creating or following anything. */
function hostSkillsRoot(host: SkillHost, root: string): { destination: string } | { reason: string } {
  const hostRoot = join(root, HOST_CONFIG_DIRECTORY[host]);
  const hostEntry = lstatSync(hostRoot, { throwIfNoEntry: false });
  if (hostEntry === undefined) return { reason: `${hostRoot} does not exist; nothing to remove.` };
  if (hostEntry.isSymbolicLink() || !hostEntry.isDirectory()) return { reason: `${hostRoot} is not a real directory.` };

  const skillsRoot = join(hostRoot, SKILLS_DIRECTORY);
  const skillsEntry = lstatSync(skillsRoot, { throwIfNoEntry: false });
  if (skillsEntry === undefined) return { reason: `${skillsRoot} does not exist; nothing to remove.` };
  if (skillsEntry.isSymbolicLink() || !skillsEntry.isDirectory()) {
    return { reason: `${skillsRoot} is not a real directory.` };
  }
  return { destination: skillsRoot };
}

/**
 * Copy the packaged skills into each requested host's skill directory.
 *
 * Existing `context-tree-*` directories are replaced; that is the upgrade path. Skill
 * directories the package does not own are never touched. A project install always
 * creates its target, because the caller named it.
 */
export function installSkills(options: InstallSkillsOptions = {}): InstallSkillsResult {
  const skillsRoot = resolvePackagedResource("skills");
  const skills = packagedSkillNames(skillsRoot);
  if (skills.length === 0) throw new Error("Packaged skills are missing; reinstall @first-tree-ai/context-tree.");

  const hosts = options.hosts === undefined || options.hosts.length === 0 ? SKILL_HOSTS : options.hosts;
  const projectRoot = options.projectPath === undefined ? undefined : resolve(options.projectPath);
  const root = projectRoot ?? realHome();

  const installed: SkillInstallation[] = [];
  const skipped: SkillInstallSkip[] = [];

  for (const host of hosts) {
    const resolved = hostDestination(host, root, projectRoot !== undefined);
    if ("reason" in resolved) {
      skipped.push({ host, reason: resolved.reason });
      continue;
    }
    for (const skill of skills) {
      const target = join(resolved.destination, skill);
      if (lstatSync(target, { throwIfNoEntry: false }) !== undefined) {
        rmSync(target, { force: true, recursive: true });
      }
      copyRealTree(join(skillsRoot, skill), target);
    }
    installed.push({ host, path: resolved.destination, skills });
  }

  return { installed, schemaVersion: SCHEMA_VERSION, skipped, version: readPackageVersion() };
}

/** Remove every skill owned by the `context-tree-` prefix from each requested host. */
export function uninstallSkills(options: UninstallSkillsOptions = {}): UninstallSkillsResult {
  const hosts = options.hosts === undefined || options.hosts.length === 0 ? SKILL_HOSTS : options.hosts;
  const root = options.projectPath === undefined ? realHome() : resolve(options.projectPath);
  const removed: SkillInstallation[] = [];
  const skipped: SkillInstallSkip[] = [];

  for (const host of hosts) {
    const resolved = hostSkillsRoot(host, root);
    if ("reason" in resolved) {
      skipped.push({ host, reason: resolved.reason });
      continue;
    }

    const skills: string[] = [];
    for (const entry of readdirSync(resolved.destination, { withFileTypes: true })) {
      if (!entry.name.startsWith(OWNED_SKILL_PREFIX)) continue;
      const target = join(resolved.destination, entry.name);
      const targetEntry = lstatSync(target, { throwIfNoEntry: false });
      if (targetEntry === undefined) continue;
      if (targetEntry.isSymbolicLink() || !targetEntry.isDirectory()) {
        skipped.push({ host, reason: `${target} is not a real directory.` });
        continue;
      }
      rmSync(target, { force: true, recursive: true });
      skills.push(entry.name);
    }
    removed.push({ host, path: resolved.destination, skills: skills.sort() });
  }

  return { removed, schemaVersion: SCHEMA_VERSION, skipped, version: readPackageVersion() };
}
