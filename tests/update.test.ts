import { mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { CommandRunner } from "../src/adapters/git.js";
import { readPackageVersion } from "../src/adapters/package.js";
import {
  compareVersions,
  currentUpdateNotice,
  detectInstallMethod,
  managingHost,
  owningPackage,
  registryUrl,
  type UpgradeDependencies,
  updateCheckDisabled,
  updateNotice,
  upgradeInstallation,
  writeUpdateCache,
} from "../src/adapters/update.js";
import { runContextTreeCli } from "../src/cli/api.js";
import {
  syncResultSchema,
  type UpdateNotice,
  upgradeResultSchema,
  verifyTreeReportSchema,
} from "../src/contracts/index.js";
import { useFixture } from "./helpers.js";

const fixture = useFixture();
const notice = updateNotice("2.0.0", "2.1.0", undefined);

async function cli(
  args: string[],
  extra: { updateNotice?: () => UpdateNotice | undefined; upgrade?: () => UpgradeDependencies } = {
    updateNotice: () => notice,
  },
): Promise<{ status: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const status = await runContextTreeCli(["node", "context-tree", ...args], {
    cwd: () => fixture().project,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
    ...extra,
  });
  return { status, out, err };
}

function packageAt(root: string, version: string, name = "@first-tree-ai/context-tree"): string {
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "package.json"), JSON.stringify({ name, version }));
  return realpathSync(root);
}

describe("update notice", () => {
  it("orders versions by SemVer precedence", () => {
    expect(compareVersions("2.1.0", "2.0.0")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.1-alpha.202611230203")).toBe(-1);
    expect(compareVersions("2.0.1-alpha.2", "2.0.1-alpha.10")).toBe(-1);
    expect(compareVersions("2.0.1-alpha", "2.0.1-alpha.1")).toBe(-1);
    expect(compareVersions("10.0.0", "9.9.9")).toBe(1);
    expect(compareVersions("2.0.0", "2.0.0")).toBe(0);
    expect(compareVersions("latest", "2.0.0")).toBeUndefined();
  });

  it("announces only a newer release and names a managing host instead of a command", () => {
    expect(updateNotice("2.0.0", "2.0.0", undefined)).toBeUndefined();
    expect(updateNotice("2.1.0", "2.0.0", undefined)).toBeUndefined();
    expect(updateNotice("2.0.0", undefined, undefined)).toBeUndefined();
    expect(notice).toEqual({
      current: "2.0.0",
      latest: "2.1.0",
      command: "context-tree upgrade",
      message: "Update available: context-tree 2.0.0 → 2.1.0. Run `context-tree upgrade`.",
    });
    const managed = updateNotice("2.0.0", "2.1.0", "OpenTag");
    expect(managed?.command).toBeNull();
    expect(managed?.managedBy).toBe("OpenTag");
    expect(managed?.message).toContain("OpenTag manages this copy");
  });

  it("is off when opted out or in CI", () => {
    expect(updateCheckDisabled({})).toBe(false);
    expect(updateCheckDisabled({ CONTEXT_TREE_NO_UPDATE_CHECK: "1" })).toBe(true);
    expect(updateCheckDisabled({ NO_UPDATE_NOTIFIER: "true" })).toBe(true);
    expect(updateCheckDisabled({ CI: "true" })).toBe(true);
    expect(updateCheckDisabled({ CI: "false" })).toBe(false);
    expect(currentUpdateNotice({ CI: "1" })).toBeUndefined();
  });

  it("reads a fresh daily cache without touching the network", () => {
    const current = readPackageVersion();
    writeUpdateCache("999.0.0");
    const fresh = currentUpdateNotice({});
    expect(fresh?.latest).toBe("999.0.0");
    expect(fresh?.current).toBe(current);
    expect(fresh?.message).toContain("999.0.0");
    expect(currentUpdateNotice({ CONTEXT_TREE_MANAGED_BY: "OpenTag" })?.managedBy).toBe("OpenTag");
    writeUpdateCache(current);
    expect(currentUpdateNotice({})).toBeUndefined();
  });

  it("uses the scoped or default npm registry", () => {
    const { home } = fixture();
    const npmrc = join(home, ".npmrc");
    expect(registryUrl({}, npmrc)).toBe("https://registry.npmjs.org/");
    writeFileSync(npmrc, "registry=https://registry.example.test\n");
    expect(registryUrl({}, npmrc)).toBe("https://registry.example.test/");
    writeFileSync(npmrc, "registry=https://a.example.test/\n@first-tree-ai:registry=https://b.example.test/\n");
    expect(registryUrl({}, npmrc)).toBe("https://b.example.test/");
    writeFileSync(npmrc, "registry=file:///tmp\n");
    expect(registryUrl({}, npmrc)).toBe("https://registry.npmjs.org/");
  });

  it("identifies a host package that bundles the CLI as a dependency", () => {
    const { home } = fixture();
    packageAt(join(home, "app"), "1.0.0", "host-app");
    const nested = packageAt(join(home, "app/node_modules/@first-tree-ai/context-tree"), "2.0.0");
    expect(owningPackage(nested)).toBe("host-app");
    const stored = packageAt(
      join(home, "app/node_modules/.pnpm/@first-tree-ai+context-tree@2.0.0/node_modules/@first-tree-ai/context-tree"),
      "2.0.0",
    );
    expect(owningPackage(stored)).toBe("host-app");
    const global = packageAt(join(home, "global/node_modules/@first-tree-ai/context-tree"), "2.0.0");
    writeFileSync(join(home, "global/package.json"), "{}");
    expect(owningPackage(global)).toBeUndefined();
    expect(managingHost({}, nested)).toBe("host-app");
    expect(managingHost({ CONTEXT_TREE_MANAGED_BY: "OpenTag" }, global)).toBe("OpenTag");
    expect(managingHost({}, join(home, "_npx/abc/node_modules/@first-tree-ai/context-tree"))).toBeUndefined();
  });
});

describe("CLI notice", () => {
  it("adds the notice as a JSON field and keeps machine commands off stderr", async () => {
    await cli(["init", "docs"]);
    const synced = await cli(["sync"]);
    expect(synced.err).toBe("");
    expect(synced.out.trim().split("\n")).toHaveLength(1);
    expect(syncResultSchema.parse(JSON.parse(synced.out)).update).toEqual(notice);
    const verified = await cli(["verify", "--json"]);
    expect(verifyTreeReportSchema.parse(JSON.parse(verified.out)).update?.latest).toBe("2.1.0");
    expect(verified.err).toBe("");
    const failed = await cli(["sync", "--tree", "missing"]);
    expect(JSON.parse(failed.out).update).toEqual(notice);
  });

  it("prints one stderr line after text output", async () => {
    await cli(["init", "docs"]);
    const verified = await cli(["verify"]);
    expect(verified.out).toContain("Context Tree OK.");
    expect(verified.err).toBe(`context-tree: ${notice?.message}\n`);
    const failed = await cli(["read", "missing.md"]);
    expect(failed.status).toBe(1);
    expect(failed.err.trim().split("\n").at(-1)).toBe(`context-tree: ${notice?.message}`);
  });

  it("skips the notice for version, help, and upgrade, and when no check is configured", async () => {
    const version = await cli(["--version"]);
    expect(version.out.trim()).toBe(readPackageVersion());
    expect(version.err).toBe("");
    expect((await cli(["upgrade", "--json"])).out).not.toContain('"update"');
    await cli(["init", "docs"]);
    expect((await cli(["sync"], {})).out).not.toContain('"update"');
  });
});

describe("upgrade", () => {
  function globalInstall(manager: "npm" | "pnpm"): {
    deps: UpgradeDependencies;
    calls: string[][];
    root: string;
  } {
    const { home } = fixture();
    const globalRoot = join(home, manager, "node_modules");
    const root = packageAt(join(globalRoot, "@first-tree-ai/context-tree"), "2.0.0");
    const calls: string[][] = [];
    const run: CommandRunner = (command, args) => {
      calls.push([command, ...args]);
      if (args[0] === "root")
        return command === manager
          ? { status: 0, stdout: `${globalRoot}\n`, stderr: "" }
          : { status: 1, stdout: "", stderr: "" };
      if (command === manager) {
        packageAt(root, "2.1.0");
        return { status: 0, stdout: "", stderr: "" };
      }
      return {
        status: 0,
        stdout: JSON.stringify({
          installed: [{ host: "claude", path: join(home, ".claude/skills"), skills: ["context-tree-read"] }],
          schemaVersion: 3,
          skipped: [],
          version: "2.1.0",
        }),
        stderr: "",
      };
    };
    return {
      deps: { env: {}, root, current: "2.0.0", run, fetchLatest: async () => "2.1.0", nodePath: "/node" },
      calls,
      root,
    };
  }

  it("upgrades a global npm install and refreshes skills from the new copy", async () => {
    const { deps, calls, root } = globalInstall("npm");
    const result = upgradeResultSchema.parse(await upgradeInstallation(deps));
    expect(result).toMatchObject({ upgraded: true, method: "npm", previous: "2.0.0", current: "2.1.0" });
    expect(result.skills?.installed[0]?.host).toBe("claude");
    expect(calls).toContainEqual(["npm", "install", "--global", "@first-tree-ai/context-tree@latest"]);
    expect(calls.at(-1)).toEqual(["/node", join(root, "dist/cli/index.mjs"), "skills", "install"]);
    const cache = JSON.parse(readFileSync(join(fixture().home, ".context-tree/update-check.json"), "utf8"));
    expect(cache.latest).toBe("2.1.0");
  });

  it("upgrades a global pnpm install", async () => {
    const { deps, calls } = globalInstall("pnpm");
    expect((await upgradeInstallation(deps)).method).toBe("pnpm");
    expect(calls).toContainEqual(["pnpm", "add", "--global", "@first-tree-ai/context-tree@latest"]);
  });

  it("does nothing when already on the newest release", async () => {
    const { deps, calls } = globalInstall("npm");
    const result = await upgradeInstallation({ ...deps, fetchLatest: async () => "2.0.0" });
    expect(result).toMatchObject({ upgraded: false, current: "2.0.0", skills: null });
    expect(calls.some((call) => call[1] === "install")).toBe(false);
  });

  it("reports a failed package manager run", async () => {
    const { deps } = globalInstall("npm");
    const run: CommandRunner = (command, args) =>
      args[0] === "install" ? { status: 1, stdout: "", stderr: "EACCES: permission denied" } : deps.run(command, args);
    await expect(upgradeInstallation({ ...deps, run })).rejects.toThrow(/EACCES/u);
  });

  it("refuses managed, npx, dependency, and unknown installs", () => {
    const { home } = fixture();
    const none: CommandRunner = () => ({ status: 1, stdout: "", stderr: "" });
    const base = { env: {}, run: none };
    expect(() => detectInstallMethod({ ...base, env: { CONTEXT_TREE_MANAGED_BY: "OpenTag" }, root: home })).toThrow(
      /OpenTag manages this copy/u,
    );
    expect(() =>
      detectInstallMethod({ ...base, root: join(home, "_npx/abc/node_modules/@first-tree-ai/context-tree") }),
    ).toThrow(/npx/u);
    packageAt(join(home, "app"), "1.0.0", "host-app");
    const nested = packageAt(join(home, "app/node_modules/@first-tree-ai/context-tree"), "2.0.0");
    expect(() => detectInstallMethod({ ...base, root: nested })).toThrow(/host-app manages this copy/u);
    expect(() => detectInstallMethod({ ...base, root: home })).toThrow(/npm install --global/u);
  });

  it("reports a refusal with its error code", async () => {
    const { home } = fixture();
    const deps: UpgradeDependencies = {
      env: { CONTEXT_TREE_MANAGED_BY: "OpenTag" },
      root: home,
      current: "2.0.0",
      run: () => ({ status: 1, stdout: "", stderr: "" }),
      fetchLatest: async () => "2.1.0",
      nodePath: "/node",
    };
    const json = await cli(["upgrade", "--json"], { upgrade: () => deps });
    expect(json.status).toBe(1);
    expect(JSON.parse(json.out).error.code).toBe("UPGRADE_UNAVAILABLE");
    const text = await cli(["upgrade"], { upgrade: () => deps });
    expect(text.err).toBe("context-tree: OpenTag manages this copy of context-tree; update it there.\n");
  });

  it("prints a text summary", async () => {
    const { deps } = globalInstall("npm");
    const text = await cli(["upgrade"], { upgrade: () => deps });
    expect(text.status).toBe(0);
    expect(text.out).toContain("Upgraded context-tree 2.0.0 → 2.1.0 with npm.");
    expect(text.out).toContain("Refreshed skills for claude.");
    expect(readFileSync(join(deps.root, "package.json"), "utf8")).toContain("2.1.0");
  });
});
