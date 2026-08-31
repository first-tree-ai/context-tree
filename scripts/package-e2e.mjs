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
  symlinkSync,
  unlinkSync,
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
  if (!options.allowSignal) {
    assert.equal(result.signal, null, `Node process was terminated by ${result.signal ?? "an unknown signal"}`);
  }
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

  const packagedSkills = [
    "context-tree-connect",
    "context-tree-create",
    "context-tree-publish",
    "context-tree-read",
    "context-tree-setup",
    "context-tree-write",
  ];
  for (const skill of packagedSkills) {
    requirePackagedFile(extractedPackage, `skills/${skill}/SKILL.md`);
    requirePackagedFile(extractedPackage, `skills/${skill}/agents/openai.yaml`);
    requirePackagedFile(extractedPackage, `skills/${skill}/scripts/context-tree.mjs`);
    assert.equal(
      readFileSync(join(extractedPackage, `skills/${skill}/agents/openai.yaml`), "utf8"),
      readFileSync(join(projectRoot, `skills/${skill}/agents/openai.yaml`), "utf8"),
      `packed OpenAI metadata must remain byte-identical for ${skill}`,
    );
    assert.match(
      readFileSync(join(extractedPackage, `skills/${skill}/SKILL.md`), "utf8"),
      /node "<skill-directory>\/scripts\/context-tree\.mjs" --version/u,
    );
  }

  const extractedCli = join(extractedPackage, "dist/cli/index.mjs");
  const extractedVersion = runNode(extractedCli, extractedPackage, ["--version"]);
  assert.equal(extractedVersion.status, 0);
  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.equal(extractedVersion.stdout, `${manifest.version}\n`);

  const referenceLauncherSource = readFileSync(
    join(extractedPackage, "skills", packagedSkills[0], "scripts/context-tree.mjs"),
    "utf8",
  );
  for (const skill of packagedSkills) {
    const launcher = join(extractedPackage, "skills", skill, "scripts/context-tree.mjs");
    assert.equal(readFileSync(launcher, "utf8"), referenceLauncherSource, "skill launchers must be byte-identical");
    for (const args of [["--version"], ["--help"], ["policy"], ["not-a-command"]]) {
      const direct = runNode(extractedCli, extractedPackage, args);
      const launched = runNode(launcher, extractedPackage, args);
      assert.deepEqual(
        { signal: launched.signal, status: launched.status, stderr: launched.stderr, stdout: launched.stdout },
        { signal: direct.signal, status: direct.status, stderr: direct.stderr, stdout: direct.stdout },
      );
    }
  }

  const savedRealCli = join(temporaryRoot, "saved-real-cli.mjs");
  renameSync(extractedCli, savedRealCli);
  writeFileSync(
    extractedCli,
    'process.stdout.write(JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd() }) + "\\n"); process.stderr.write("forwarded stderr\\n"); process.exit(7);\n',
  );
  const forwardingArguments = ["argument with spaces", "--literal", "value"];
  const forwardingDirect = runNode(extractedCli, temporaryRoot, forwardingArguments);
  const forwardingLauncher = runNode(
    join(extractedPackage, "skills/context-tree-read/scripts/context-tree.mjs"),
    temporaryRoot,
    forwardingArguments,
  );
  assert.deepEqual(
    {
      signal: forwardingLauncher.signal,
      status: forwardingLauncher.status,
      stderr: forwardingLauncher.stderr,
      stdout: forwardingLauncher.stdout,
    },
    {
      signal: forwardingDirect.signal,
      status: forwardingDirect.status,
      stderr: forwardingDirect.stderr,
      stdout: forwardingDirect.stdout,
    },
    "the launcher must forward arguments, CWD, output, and nonzero exit status",
  );
  writeFileSync(extractedCli, 'process.kill(process.pid, "SIGTERM");\n');
  const signaledDirect = runNode(extractedCli, extractedPackage, [], { allowSignal: true });
  const signaledLauncher = runNode(
    join(extractedPackage, "skills/context-tree-read/scripts/context-tree.mjs"),
    extractedPackage,
    [],
    { allowSignal: true },
  );
  assert.equal(signaledDirect.signal, "SIGTERM");
  assert.equal(signaledLauncher.signal, signaledDirect.signal, "the launcher must propagate child signals");
  rmSync(extractedCli);
  renameSync(savedRealCli, extractedCli);

  const reinstallMessage = "Context Tree packaged CLI is unavailable. Reinstall or update the Context Tree plugin.\n";
  const fakeBin = join(temporaryRoot, "fake-bin");
  mkdirSync(fakeBin);
  const invocationMarker = join(temporaryRoot, "path-cli-was-invoked");
  const fakePathCli = join(fakeBin, "context-tree");
  writeFileSync(fakePathCli, `#!/bin/sh\n: >"${invocationMarker}"\nexit 23\n`);
  chmodSync(fakePathCli, 0o755);
  const launcher = join(extractedPackage, "skills", packagedSkills[0], "scripts/context-tree.mjs");
  const assertLauncherRejected = () => {
    const result = runNode(launcher, extractedPackage, ["--version"], {
      env: { ...npmEnvironment, PATH: fakeBin },
    });
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.equal(result.stderr, reinstallMessage);
    assert.equal(existsSync(invocationMarker), false, "the launcher must never invoke a CLI found on PATH");
  };

  const savedCli = join(temporaryRoot, "saved-cli.mjs");
  renameSync(extractedCli, savedCli);
  assertLauncherRejected();
  renameSync(savedCli, extractedCli);

  const packageJson = join(extractedPackage, "package.json");
  const packageJsonSource = readFileSync(packageJson, "utf8");
  writeFileSync(packageJson, JSON.stringify({ ...manifest, name: "wrong-package" }));
  assertLauncherRejected();
  writeFileSync(packageJson, packageJsonSource);

  const externalPackageJson = join(temporaryRoot, "external-package.json");
  writeFileSync(externalPackageJson, packageJsonSource);
  renameSync(packageJson, `${packageJson}.saved`);
  symlinkSync(externalPackageJson, packageJson);
  assertLauncherRejected();
  rmSync(packageJson);
  renameSync(`${packageJson}.saved`, packageJson);

  const externalCli = join(temporaryRoot, "external-cli.mjs");
  writeFileSync(externalCli, "process.exit(0);\n");
  renameSync(extractedCli, savedCli);
  symlinkSync(externalCli, extractedCli);
  assertLauncherRejected();
  rmSync(extractedCli);
  renameSync(savedCli, extractedCli);

  const distDirectory = join(extractedPackage, "dist");
  const savedDistDirectory = join(temporaryRoot, "saved-dist");
  const externalDistDirectory = join(temporaryRoot, "external-dist");
  mkdirSync(join(externalDistDirectory, "cli"), { recursive: true });
  writeFileSync(join(externalDistDirectory, "cli/index.mjs"), "process.exit(0);\n");
  renameSync(distDirectory, savedDistDirectory);
  symlinkSync(externalDistDirectory, distDirectory);
  assertLauncherRejected();
  unlinkSync(distDirectory);
  renameSync(savedDistDirectory, distDirectory);

  const hook = runNode(join(extractedPackage, "hooks/session-start.mjs"), extractedPackage, [], {
    env: { ...npmEnvironment, CLAUDE_PLUGIN_ROOT: extractedPackage },
    input: JSON.stringify({ cwd: extractedPackage, hook_event_name: "SessionStart" }),
  });
  assert.equal(hook.status, 0);
  assert.equal(hook.stdout, "", "the packaged hook must remain silent for an unconnected project");

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
    "connectProject",
    "createProject",
    "finishContextWrite",
    "listManagedTrees",
    "prepareContextWrite",
    "publishProject",
    "readContextTreePolicy",
    "readTree",
    "resolveConnection",
    "syncProject",
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
  assert.equal(schemaExports.includes("contextTreeConnectionResultSchema"), true);
  assert.equal(schemaExports.includes("managedTreeListingResultSchema"), true);
  assert.equal(schemaExports.includes("contextTreeConnectionsFileSchema"), false);
  assert.equal(schemaExports.includes("scaffoldTreeResultSchema"), false);

  const help = runCli(cliPath, consumerRoot, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context-tree \[options\] \[command\]/u);

  const version = runCli(cliPath, consumerRoot, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${manifest.version}\n`);

  const created = runCli(cliPath, consumerRoot, ["create", "--project-path", "."]);
  assert.equal(created.status, 0);
  parseWithInstalledSchema(consumerRoot, "createProjectResultSchema", created.stdout);
  const treePath = JSON.parse(created.stdout).treePath;
  const packagedTemplates = readdirSync(join(extractedPackage, "templates"));
  assert.equal(packagedTemplates.includes("AGENTS.md"), true);
  assert.equal(packagedTemplates.includes("agents.md"), false);
  assert.equal(lstatSync(join(treePath, "CLAUDE.md")).isSymbolicLink(), true);
  assert.equal(readlinkSync(join(treePath, "CLAUDE.md")), "AGENTS.md");
  assert.equal(readFileSync(join(treePath, ".git/HEAD"), "utf8"), "ref: refs/heads/trunk\n");
  assert.match(
    readFileSync(join(treePath, ".github/workflows/validate-context-tree.yml"), "utf8"),
    /branches: \["trunk"\]/u,
  );
  assert.match(JSON.parse(created.stdout).commitSha, /^[0-9a-f]{40}$/u, "create must report the scaffold commit");
  const resolved = runCli(cliPath, consumerRoot, ["resolve"]);
  assert.equal(resolved.status, 0);
  parseWithInstalledSchema(consumerRoot, "contextTreeConnectionResultSchema", resolved.stdout);
  const connectedHook = runNode(join(extractedPackage, "hooks/session-start.mjs"), consumerRoot, [], {
    env: { ...npmEnvironment, CLAUDE_PLUGIN_ROOT: extractedPackage },
    input: JSON.stringify({ cwd: consumerRoot, hook_event_name: "SessionStart" }),
  });
  assert.equal(connectedHook.status, 0);
  assert.equal(
    JSON.parse(connectedHook.stdout).hookSpecificOutput.additionalContext,
    `Context Tree connected at ${treePath}`,
  );
  const installedPackage = join(consumerRoot, "node_modules/@first-tree-ai/context-tree");
  assert.equal(existsSync(join(installedPackage, "plugin.json")), false, "installed plugin must omit root plugin.json");
  const installedDirectCli = join(installedPackage, "dist/cli/index.mjs");
  const installedLauncher = join(installedPackage, "skills/context-tree-read/scripts/context-tree.mjs");
  const directResolve = runNode(installedDirectCli, consumerRoot, ["resolve"]);
  const launchedResolve = runNode(installedLauncher, consumerRoot, ["resolve"]);
  assert.deepEqual(
    {
      signal: launchedResolve.signal,
      status: launchedResolve.status,
      stderr: launchedResolve.stderr,
      stdout: launchedResolve.stdout,
    },
    {
      signal: directResolve.signal,
      status: directResolve.status,
      stderr: directResolve.stderr,
      stdout: directResolve.stdout,
    },
    "the launcher must preserve CWD-based project resolution",
  );
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

  const validVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", treePath]);
  assert.equal(validVerify.status, 0);
  parseWithInstalledSchema(consumerRoot, "verifyTreeReportSchema", validVerify.stdout);

  const read = runCli(cliPath, consumerRoot, ["read", "--tree-path", treePath]);
  assert.equal(read.status, 0);
  parseWithInstalledSchema(consumerRoot, "contextTreeReadResultSchema", read.stdout);

  rmSync(join(treePath, "NODE.md"));
  const invalidVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", treePath]);
  assert.equal(invalidVerify.status, 1);
  parseWithInstalledSchema(consumerRoot, "verifyTreeReportSchema", invalidVerify.stdout);
  assert.equal(JSON.parse(invalidVerify.stdout).ok, false);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
