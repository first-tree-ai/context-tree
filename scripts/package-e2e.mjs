import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "context-tree-package-e2e-"));
const gitConfig = join(temporaryRoot, "gitconfig");
writeFileSync(gitConfig, "[init]\n\tdefaultBranch = trunk\n");
const npmEnvironment = {
  ...process.env,
  GIT_CONFIG_GLOBAL: gitConfig,
  GIT_CONFIG_NOSYSTEM: "1",
  HOME: temporaryRoot,
  npm_config_cache: join(temporaryRoot, "npm-cache"),
};

function runCli(cliPath, cwd, args) {
  const result = spawnSync(cliPath, args, { cwd, encoding: "utf8", env: npmEnvironment });
  assert.equal(result.signal, null, `CLI was terminated by ${result.signal ?? "an unknown signal"}`);
  return result;
}

function runNode(scriptPath, cwd, args, options = {}) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], {
    cwd,
    encoding: "utf8",
    env: options.env ?? npmEnvironment,
    input: options.input,
  });
  assert.equal(result.signal, null, `Node process was terminated by ${result.signal ?? "an unknown signal"}`);
  return result;
}

function parseWithInstalledSchema(consumerRoot, schemaName, json) {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { ${schemaName} } from "@first-tree-ai/context-tree/schemas"; ${schemaName}.parse(JSON.parse(process.argv[1]));`,
      json,
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );
}

function requirePackagedFile(packageRoot, relativePath) {
  const path = join(packageRoot, relativePath);
  assert.equal(lstatSync(path).isFile(), true, `packed package must include ${relativePath}`);
  assert.notEqual(readFileSync(path, "utf8").length, 0, `packed package file must not be empty: ${relativePath}`);
}

try {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", temporaryRoot], {
    cwd: projectRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });
  const tarballs = readdirSync(temporaryRoot).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "npm pack must create exactly one tarball");
  const tarball = join(temporaryRoot, tarballs[0]);

  const extractedRoot = join(temporaryRoot, "extracted");
  mkdirSync(extractedRoot);
  execFileSync("tar", ["-xzf", tarball, "-C", extractedRoot], { stdio: "pipe" });
  const extractedPackage = join(extractedRoot, "package");
  assert.equal(existsSync(join(extractedPackage, "node_modules")), false);
  assert.equal(existsSync(join(extractedRoot, "node_modules")), false);
  assert.equal(existsSync(join(temporaryRoot, "node_modules")), false);
  assert.equal(existsSync(join(extractedPackage, "plugin.json")), false, "packed plugin must omit root plugin.json");

  for (const relativePath of [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    "hooks/hooks.json",
    "hooks/session-start.mjs",
    "dist/cli/index.mjs",
  ]) {
    requirePackagedFile(extractedPackage, relativePath);
  }

  const packagedSkills = ["context-tree-link", "context-tree-init", "context-tree-read", "context-tree-write"];
  for (const skill of packagedSkills) {
    requirePackagedFile(extractedPackage, `skills/${skill}/SKILL.md`);
    requirePackagedFile(extractedPackage, `skills/${skill}/agents/openai.yaml`);
    requirePackagedFile(extractedPackage, `skills/${skill}/scripts/context-tree.mjs`);
  }

  const extractedCli = join(extractedPackage, "dist/cli/index.mjs");
  const extractedVersion = runNode(extractedCli, extractedPackage, ["--version"]);
  assert.equal(extractedVersion.status, 0);
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.equal(extractedVersion.stdout, `${manifest.version}\n`);

  const hook = runNode(join(extractedPackage, "hooks/session-start.mjs"), extractedPackage, [], {
    env: { ...npmEnvironment, CLAUDE_PLUGIN_ROOT: extractedPackage },
    input: JSON.stringify({ cwd: extractedPackage, hook_event_name: "SessionStart" }),
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "", "the packaged hook must remain silent for an unlinked project");

  for (const skill of packagedSkills) {
    const launcher = join(extractedPackage, "skills", skill, "scripts/context-tree.mjs");
    const directHelp = runNode(extractedCli, extractedPackage, ["--help"]);
    const launchedHelp = runNode(launcher, extractedPackage, ["--help"]);
    assert.deepEqual(
      { status: launchedHelp.status, stderr: launchedHelp.stderr, stdout: launchedHelp.stdout },
      { status: directHelp.status, stderr: directHelp.stderr, stdout: directHelp.stdout },
    );

    const directFailure = runNode(extractedCli, extractedPackage, ["not-a-command"]);
    const launchedFailure = runNode(launcher, extractedPackage, ["not-a-command"]);
    assert.deepEqual(
      { status: launchedFailure.status, stderr: launchedFailure.stderr, stdout: launchedFailure.stdout },
      { status: directFailure.status, stderr: directFailure.stderr, stdout: directFailure.stdout },
    );
  }

  const missingCli = join(extractedPackage, "dist/cli/index.missing.mjs");
  renameSync(extractedCli, missingCli);
  const fakeBin = join(temporaryRoot, "fake-bin");
  mkdirSync(fakeBin, { recursive: true });
  const invocationMarker = join(temporaryRoot, "global-cli-was-invoked");
  const fakeGlobal = join(fakeBin, "context-tree");
  writeFileSync(fakeGlobal, `#!/bin/sh\n: >"${invocationMarker}"\nexit 23\n`);
  chmodSync(fakeGlobal, 0o755);
  for (const skill of packagedSkills) {
    const launcher = join(extractedPackage, "skills", skill, "scripts/context-tree.mjs");
    const missing = runNode(launcher, extractedPackage, ["--version"], {
      env: { ...npmEnvironment, PATH: fakeBin },
    });
    assert.equal(missing.status, 1);
    assert.equal(missing.stdout, "");
    assert.equal(
      missing.stderr,
      "Context Tree packaged CLI is unavailable. Reinstall or update the Context Tree plugin.\n",
    );
  }
  assert.equal(existsSync(invocationMarker), false, "a launcher must never invoke a CLI found on PATH");
  renameSync(missingCli, extractedCli);

  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    '{"name":"context-tree-package-e2e","private":true,"type":"module"}\n',
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", tarball], {
    cwd: consumerRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });

  const cliPath = join(consumerRoot, "node_modules/.bin/context-tree");

  const mainExports = execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      'import * as api from "@first-tree-ai/context-tree"; process.stdout.write(JSON.stringify(Object.keys(api).sort()));',
    ],
    { cwd: consumerRoot, encoding: "utf8" },
  );
  assert.deepEqual(JSON.parse(mainExports), [
    "inspectContextTreeDiff",
    "linkProject",
    "readContextTreePolicy",
    "readTree",
    "refreshProject",
    "resolveLink",
    "scaffoldTree",
    "stageContextWrite",
    "verifyTree",
  ]);

  const schemaExports = JSON.parse(
    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "--eval",
        'import * as schemas from "@first-tree-ai/context-tree/schemas"; process.stdout.write(JSON.stringify(Object.keys(schemas).sort()));',
      ],
      { cwd: consumerRoot, encoding: "utf8" },
    ),
  );
  assert.equal(schemaExports.includes("contextTreeLinkResultSchema"), true);
  assert.equal(schemaExports.includes("contextTreeLinksFileSchema"), false);

  const help = runCli(cliPath, consumerRoot, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context-tree \[options\] \[command\]/u);

  const version = runCli(cliPath, consumerRoot, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${manifest.version}\n`);

  const init = runCli(cliPath, consumerRoot, ["init", "--repository", "acme/context", "--tree-path", "tree"]);
  assert.equal(init.status, 0);
  parseWithInstalledSchema(consumerRoot, "scaffoldTreeResultSchema", init.stdout);
  assert.deepEqual(JSON.parse(init.stdout).files, [
    "NODE.md",
    "AGENTS.md",
    "CLAUDE.md",
    ".github/workflows/validate-context-tree.yml",
  ]);
  const packagedTemplates = readdirSync(join(extractedPackage, "templates"));
  assert.equal(packagedTemplates.includes("AGENTS.md"), true);
  assert.equal(packagedTemplates.includes("agents.md"), false);
  assert.equal(lstatSync(join(consumerRoot, "tree/CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(consumerRoot, "tree/CLAUDE.md")), "AGENTS.md");
  assert.equal(readFileSync(join(consumerRoot, "tree/.git/HEAD"), "utf8"), "ref: refs/heads/trunk\n");
  assert.match(
    readFileSync(join(consumerRoot, "tree/.github/workflows/validate-context-tree.yml"), "utf8"),
    /branches: \["trunk"\]/u,
  );
  execFileSync("git", ["-C", join(consumerRoot, "tree"), "add", "."], { env: npmEnvironment, stdio: "pipe" });
  execFileSync(
    "git",
    [
      "-C",
      join(consumerRoot, "tree"),
      "-c",
      "user.name=Package Test",
      "-c",
      "user.email=test@example.com",
      "commit",
      "-m",
      "Initialize",
    ],
    { env: npmEnvironment, stdio: "pipe" },
  );
  const resolved = runCli(cliPath, consumerRoot, ["resolve"]);
  assert.equal(resolved.status, 0);
  parseWithInstalledSchema(consumerRoot, "contextTreeLinkResultSchema", resolved.stdout);
  const installedPackage = join(consumerRoot, "node_modules/@first-tree-ai/context-tree");
  assert.equal(existsSync(join(installedPackage, "plugin.json")), false, "installed plugin must omit root plugin.json");
  for (const relativePath of [
    ".codex-plugin/plugin.json",
    ".claude-plugin/plugin.json",
    ".agents/plugins/marketplace.json",
    ".claude-plugin/marketplace.json",
    "hooks/hooks.json",
  ]) {
    requirePackagedFile(installedPackage, relativePath);
  }
  const installedCodexManifest = JSON.parse(readFileSync(join(installedPackage, ".codex-plugin/plugin.json"), "utf8"));
  assert.equal(installedCodexManifest.hooks, "./hooks/hooks.json");
  requirePackagedFile(installedPackage, installedCodexManifest.hooks);

  const validVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", "tree"]);
  assert.equal(validVerify.status, 0);
  parseWithInstalledSchema(consumerRoot, "verifyTreeReportSchema", validVerify.stdout);

  const read = runCli(cliPath, consumerRoot, ["read", "--tree-path", "tree"]);
  assert.equal(read.status, 0);
  parseWithInstalledSchema(consumerRoot, "contextTreeReadResultSchema", read.stdout);

  rmSync(join(consumerRoot, "tree/NODE.md"));
  const invalidVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", "tree"]);
  assert.equal(invalidVerify.status, 1);
  parseWithInstalledSchema(consumerRoot, "verifyTreeReportSchema", invalidVerify.stdout);
  assert.equal(JSON.parse(invalidVerify.stdout).ok, false);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
