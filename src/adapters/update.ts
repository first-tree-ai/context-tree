import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, sep } from "node:path";
import { z } from "zod";
import {
  CLI_ERROR_CODES,
  installSkillsResultSchema,
  SCHEMA_VERSION,
  type UpdateNotice,
  type UpgradeResult,
} from "../contracts/index.js";
import { ContextTreeError } from "../errors.js";
import type { CommandRunner } from "./git.js";
import { sanitizeCommandOutput } from "./git.js";
import { packageRoot, readPackageVersion } from "./package.js";
import { atomicState, readState, stateDirectory } from "./state.js";

export const PACKAGE_NAME = "@first-tree-ai/context-tree";
export const UPGRADE_COMMAND = "context-tree upgrade";
/** A host that bundles its own copy sets this to its display name; the copy then never self-upgrades. */
export const MANAGED_BY_ENV = "CONTEXT_TREE_MANAGED_BY";
export const NO_UPDATE_CHECK_ENV = "CONTEXT_TREE_NO_UPDATE_CHECK";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const CHECK_TIMEOUT_MS = 3000;
const DEFAULT_REGISTRY = "https://registry.npmjs.org/";

type Environment = Readonly<Record<string, string | undefined>>;
const cacheSchema = z.object({ checkedAt: z.number().finite(), latest: z.string().min(1).optional() }).strict();
type UpdateCache = z.infer<typeof cacheSchema>;

function enabled(value: string | undefined): boolean {
  return value !== undefined && !["", "0", "false"].includes(value.trim().toLowerCase());
}

/** Opted out explicitly, or running in CI where nobody reads the notice. */
export function updateCheckDisabled(env: Environment): boolean {
  return enabled(env[NO_UPDATE_CHECK_ENV]) || enabled(env.NO_UPDATE_NOTIFIER) || enabled(env.CI);
}

type Version = { core: number[]; prerelease: string[] };
function parseVersion(value: string): Version | undefined {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:-([\dA-Za-z.-]+))?(?:\+[\dA-Za-z.-]+)?$/u.exec(value.trim());
  if (!match) return undefined;
  return { core: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease: match[4]?.split(".") ?? [] };
}

/** SemVer precedence; undefined when either side is not a version. */
export function compareVersions(left: string, right: string): number | undefined {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return undefined;
  for (let index = 0; index < 3; index++) {
    const difference = (a.core[index] ?? 0) - (b.core[index] ?? 0);
    if (difference !== 0) return Math.sign(difference);
  }
  if (a.prerelease.length === 0 || b.prerelease.length === 0)
    return Math.sign(b.prerelease.length - a.prerelease.length);
  for (let index = 0; index < Math.max(a.prerelease.length, b.prerelease.length); index++) {
    const x = a.prerelease[index];
    const y = b.prerelease[index];
    if (x === undefined || y === undefined) return x === undefined ? -1 : 1;
    if (x === y) continue;
    const numeric = /^\d+$/u;
    if (numeric.test(x) && numeric.test(y)) return Math.sign(Number(x) - Number(y));
    if (numeric.test(x) !== numeric.test(y)) return numeric.test(x) ? -1 : 1;
    return x < y ? -1 : 1;
  }
  return 0;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

function realPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The named package whose node_modules holds this copy, if any. A pnpm layout nests the copy in
 * `node_modules/.pnpm/<id>/node_modules`, so the owner sits above the outer node_modules. Global
 * install roots carry an unnamed package.json and are not owners.
 */
export function owningPackage(root: string): string | undefined {
  const segments = root.split(sep);
  const store = segments.lastIndexOf(".pnpm");
  const searchFrom = store > 0 && segments[store - 1] === "node_modules" ? segments.slice(0, store).join(sep) : root;
  let directory = searchFrom;
  while (dirname(directory) !== directory) {
    if (basename(directory) === "node_modules") {
      const name = (readJson(join(dirname(directory), "package.json")) as { name?: unknown } | undefined)?.name;
      return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
    }
    directory = dirname(directory);
  }
  return undefined;
}

function isNpx(root: string): boolean {
  return root.split(sep).includes("_npx");
}

/** Who owns the installed version: a declaring host, else the package this copy is a dependency of. */
export function managingHost(env: Environment, root: string): string | undefined {
  const declared = env[MANAGED_BY_ENV]?.trim();
  const printable = [...(declared ?? "")].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 0x20 && code !== 0x7f;
  });
  if (declared && printable) return declared.slice(0, 80);
  if (isNpx(root)) return undefined;
  return owningPackage(root);
}

export function updateNotice(
  current: string,
  latest: string | undefined,
  managedBy: string | undefined,
): UpdateNotice | undefined {
  if (latest === undefined || (compareVersions(latest, current) ?? 0) <= 0) return undefined;
  const available = `Update available: context-tree ${current} → ${latest}.`;
  return managedBy
    ? {
        current,
        latest,
        command: null,
        managedBy,
        message: `${available} ${managedBy} manages this copy; update ${managedBy} to get it.`,
      }
    : { current, latest, command: UPGRADE_COMMAND, message: `${available} Run \`${UPGRADE_COMMAND}\`.` };
}

function cachePath(): string {
  return join(stateDirectory(), "update-check.json");
}

function readCache(): UpdateCache | undefined {
  const parsed = cacheSchema.safeParse(readState(cachePath()));
  return parsed.success ? parsed.data : undefined;
}

export function writeUpdateCache(latest: string | undefined, now: number = Date.now()): void {
  try {
    atomicState(cachePath(), latest === undefined ? { checkedAt: now } : { checkedAt: now, latest });
  } catch {
    // The cache only saves a request; losing it is harmless.
  }
}

/** The configured npm registry for this scope, falling back to the public registry. */
export function registryUrl(env: Environment, npmrc: string = join(homedir(), ".npmrc")): string {
  let configured = env.npm_config_registry ?? env.NPM_CONFIG_REGISTRY;
  try {
    const lines = readFileSync(npmrc, "utf8").split(/\r?\n/u);
    const value = (key: string): string | undefined =>
      lines
        .map((line) => line.trim())
        .find((line) => line.startsWith(`${key}=`))
        ?.slice(key.length + 1)
        .trim();
    configured = value("@first-tree-ai:registry") ?? configured ?? value("registry");
  } catch {
    // No user npmrc.
  }
  if (!configured || !/^https?:\/\//u.test(configured)) return DEFAULT_REGISTRY;
  return configured.endsWith("/") ? configured : `${configured}/`;
}

/** The `latest` dist-tag, or undefined on any failure. Never throws. */
export async function fetchLatestVersion(
  env: Environment,
  timeoutMs: number = CHECK_TIMEOUT_MS,
): Promise<string | undefined> {
  try {
    const url = new URL(`-/package/${PACKAGE_NAME.replace("/", "%2f")}/dist-tags`, registryUrl(env));
    const response = await fetch(url, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { accept: "application/json" },
    });
    if (!response.ok) return undefined;
    const latest = z.object({ latest: z.string() }).safeParse(await response.json());
    return latest.success && parseVersion(latest.data.latest) ? latest.data.latest : undefined;
  } catch {
    return undefined;
  }
}

/** Refresh the cache; run by the detached background check. */
export async function refreshUpdateCache(env: Environment): Promise<void> {
  const latest = await fetchLatestVersion(env);
  if (latest !== undefined) writeUpdateCache(latest);
}

/**
 * The notice for this invocation, read from the daily cache. A stale or missing cache starts a
 * detached background refresh, so the current command never waits on the network; its result
 * shows from the next invocation. Every failure is silent.
 */
export function currentUpdateNotice(env: Environment): UpdateNotice | undefined {
  if (updateCheckDisabled(env)) return undefined;
  try {
    const cache = readCache();
    const now = Date.now();
    if (!cache || now - cache.checkedAt >= CHECK_INTERVAL_MS || cache.checkedAt > now + CHECK_INTERVAL_MS) {
      // Record the attempt first so concurrent commands start at most one refresh per day.
      writeUpdateCache(cache?.latest, now);
      const child = spawn(process.execPath, [join(packageRoot, "dist", "cli", "index.mjs"), "update-check"], {
        detached: true,
        stdio: "ignore",
        env: { ...process.env },
        windowsHide: true,
      });
      child.on("error", () => undefined);
      child.unref();
    }
    return updateNotice(readPackageVersion(), cache?.latest, managingHost(env, realPath(packageRoot)));
  } catch {
    return undefined;
  }
}

export type UpgradeDependencies = {
  env: Environment;
  root: string;
  current: string;
  run: CommandRunner;
  fetchLatest: () => Promise<string | undefined>;
  nodePath: string;
};

/**
 * npm and pnpm are .cmd shims on Windows, which only start through a shell. Their arguments here
 * are fixed and space-free; every other command, such as node.exe with user paths, runs directly
 * because a shell would split its unquoted paths.
 */
export function needsShell(command: string, platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32" && (command === "npm" || command === "pnpm");
}

export function upgradeRunner(command: string, args: string[]): ReturnType<CommandRunner> {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 300_000,
    shell: needsShell(command),
    windowsHide: true,
  });
  return {
    status: result.status,
    stdout: typeof result.stdout === "string" ? result.stdout : "",
    stderr: result.error ? "Unable to start command." : typeof result.stderr === "string" ? result.stderr : "",
  };
}

export function defaultUpgradeDependencies(): UpgradeDependencies {
  return {
    env: process.env,
    root: realPath(packageRoot),
    current: readPackageVersion(),
    run: upgradeRunner,
    fetchLatest: () => fetchLatestVersion(process.env, 10_000),
    nodePath: process.execPath,
  };
}

type Method = UpgradeResult["method"];

function globalPackage(manager: Method, run: CommandRunner): string | undefined {
  const result = run(manager, ["root", "--global"]);
  const root = result.status === 0 ? result.stdout.trim().split(/\r?\n/u).at(-1) : undefined;
  return root ? join(root, ...PACKAGE_NAME.split("/")) : undefined;
}

function unavailable(message: string): ContextTreeError {
  return new ContextTreeError(CLI_ERROR_CODES.upgradeUnavailable, message);
}

/** The global package manager that installed `root`, or a refusal explaining who owns the copy. */
export function detectInstallMethod(deps: Pick<UpgradeDependencies, "env" | "root" | "run">): Method {
  const declared = deps.env[MANAGED_BY_ENV]?.trim();
  if (declared)
    throw unavailable(`${managingHost(deps.env, deps.root)} manages this copy of context-tree; update it there.`);
  if (isNpx(deps.root))
    throw unavailable(`This copy runs through npx; run \`npx ${PACKAGE_NAME}@latest\` to use the newest release.`);
  for (const manager of ["npm", "pnpm"] as const) {
    const installed = globalPackage(manager, deps.run);
    if (installed && existsSync(installed) && realPath(installed) === deps.root) return manager;
  }
  const owner = owningPackage(deps.root);
  if (owner) throw unavailable(`${owner} manages this copy of context-tree; update ${owner} to get a newer one.`);
  throw unavailable(
    `This copy was not installed globally with npm or pnpm (${deps.root}); run \`npm install --global ${PACKAGE_NAME}@latest\`.`,
  );
}

/** Upgrade a global npm or pnpm install to `latest`, then refresh the installed skills from the new copy. */
export async function upgradeInstallation(deps: UpgradeDependencies): Promise<UpgradeResult> {
  const method = detectInstallMethod(deps);
  const latest = (await deps.fetchLatest()) ?? null;
  const base = { schemaVersion: SCHEMA_VERSION, method, previous: deps.current, latest };
  if (latest !== null && (compareVersions(latest, deps.current) ?? 1) <= 0) {
    writeUpdateCache(latest);
    return { ...base, upgraded: false, current: deps.current, skills: null };
  }
  const args =
    method === "npm"
      ? ["install", "--global", `${PACKAGE_NAME}@latest`]
      : ["add", "--global", `${PACKAGE_NAME}@latest`];
  const result = deps.run(method, args);
  if (result.status !== 0) {
    const detail = sanitizeCommandOutput(result.stderr).trim().slice(-600);
    throw new Error(`\`${method} ${args.join(" ")}\` failed${detail ? `: ${detail}` : "."}`);
  }
  const installed = realPath(globalPackage(method, deps.run) ?? deps.root);
  const version = (readJson(join(installed, "package.json")) as { version?: unknown } | undefined)?.version;
  const current = typeof version === "string" ? version : (latest ?? deps.current);
  // pnpm does not run dependency install scripts by default, so refresh skills explicitly.
  const skills = deps.run(deps.nodePath, [join(installed, "dist", "cli", "index.mjs"), "skills", "install"]);
  let parsed: UpgradeResult["skills"] = null;
  try {
    const value = installSkillsResultSchema.safeParse(JSON.parse(skills.stdout));
    if (skills.status === 0 && value.success) parsed = value.data;
  } catch {
    parsed = null;
  }
  writeUpdateCache(current);
  return { ...base, upgraded: current !== deps.current, current, skills: parsed };
}

export function formatUpgrade(result: UpgradeResult): string {
  if (!result.upgraded) return `context-tree ${result.current} is already the newest release.`;
  const lines = [`Upgraded context-tree ${result.previous} → ${result.current} with ${result.method}.`];
  if (result.skills === null) lines.push("Skills were not refreshed; run `context-tree skills install`.");
  else if (result.skills.installed.length > 0)
    lines.push(`Refreshed skills for ${result.skills.installed.map((entry) => entry.host).join(", ")}.`);
  lines.push("Restart your agent to pick up the new skills.");
  return lines.join("\n");
}
