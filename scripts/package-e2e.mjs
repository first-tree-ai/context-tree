import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
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

const SKILLS = [
  "context-tree-connect",
  "context-tree-create",
  "context-tree-publish",
  "context-tree-read",
  "context-tree-setup",
  "context-tree-write",
];

function runCli(cliPath, cwd, args) {
  const result = spawnSync(cliPath, args, { cwd, encoding: "utf8", env: npmEnvironment });
  assert.equal(result.signal, null, `CLI was terminated by ${result.signal ?? "an unknown signal"}`);
  return result;
}

function runNode(scriptPath, cwd, args) {
  const result = spawnSync(process.execPath, [scriptPath, ...args], { cwd, encoding: "utf8", env: npmEnvironment });
  assert.equal(result.signal, null, `Node process was terminated by ${result.signal ?? "an unknown signal"}`);
  return result;
}

function requirePackagedFile(packageRoot, relativePath) {
  const path = join(packageRoot, relativePath);
  assert.equal(lstatSync(path).isFile(), true, `packed package must include ${relativePath}`);
  assert.notEqual(readFileSync(path, "utf8").length, 0, `packed package file must not be empty: ${relativePath}`);
}

/** The JSON contracts are covered by the unit tests; here we only assert the wire shape survives packing. */
function parseOneLineJson(output) {
  const parsed = JSON.parse(output);
  assert.equal(parsed.schemaVersion, 1, "every machine-readable response must carry schema version 1");
  return parsed;
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

  for (const relativePath of ["dist/cli/index.mjs", "scripts/postinstall.mjs", "templates/AGENTS.md"]) {
    requirePackagedFile(extractedPackage, relativePath);
  }
  for (const skill of SKILLS) {
    requirePackagedFile(extractedPackage, `skills/${skill}/SKILL.md`);
    requirePackagedFile(extractedPackage, `skills/${skill}/agents/openai.yaml`);
    assert.equal(
      readFileSync(join(extractedPackage, `skills/${skill}/agents/openai.yaml`), "utf8"),
      readFileSync(join(projectRoot, `skills/${skill}/agents/openai.yaml`), "utf8"),
      `packed OpenAI metadata must remain byte-identical for ${skill}`,
    );
    assert.match(
      readFileSync(join(extractedPackage, `skills/${skill}/SKILL.md`), "utf8"),
      /npm install --global @first-tree-ai\/context-tree/u,
    );
  }

  // `files` is an allowlist, so these guard the regressions that could plausibly
  // re-add an entry: shipping the repo docs, emitting a library entry point again,
  // or reintroducing a per-skill launcher script.
  for (const relativePath of ["docs", "dist/index.mjs", "dist/schemas.mjs", "skills/context-tree-read/scripts"]) {
    assert.equal(
      existsSync(join(extractedPackage, relativePath)),
      false,
      `packed package must not include ${relativePath}`,
    );
  }

  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  assert.equal(manifest.exports, undefined, "the package must expose only its bin");
  const extractedVersion = runNode(join(extractedPackage, "dist/cli/index.mjs"), extractedPackage, ["--version"]);
  assert.equal(extractedVersion.status, 0);
  assert.equal(extractedVersion.stdout, `${manifest.version}\n`);

  // A host directory the user already has, so postinstall has somewhere to install.
  mkdirSync(join(temporaryRoot, ".claude"));

  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    '{"name":"context-tree-package-e2e","private":true,"type":"module"}\n',
  );
  execFileSync("npm", ["install", "--no-audit", "--no-fund", tarball], {
    cwd: consumerRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });

  const installedPackage = join(consumerRoot, "node_modules/@first-tree-ai/context-tree");

  // A local dependency install must never silently write to the home directory.
  assert.equal(
    existsSync(join(temporaryRoot, ".claude", "skills")),
    false,
    "a local install must not write skills to the home directory",
  );

  // Nor does a global install of a package that depends on this one: npm sets npm_config_global
  // for its dependencies too, and this copy is nested inside the consumer, which is that layout.
  const nestedPostinstall = spawnSync(process.execPath, [join(installedPackage, "scripts/postinstall.mjs")], {
    cwd: consumerRoot,
    encoding: "utf8",
    env: { ...npmEnvironment, npm_config_global: "true" },
  });
  assert.equal(nestedPostinstall.status, 0, "postinstall must never fail an install");
  assert.match(nestedPostinstall.stdout, /run `context-tree install`/u);
  assert.equal(
    existsSync(join(temporaryRoot, ".claude", "skills")),
    false,
    "a global install of a dependent package must not write skills to the home directory",
  );

  // A direct global install does. Installing for real is what proves it, because the layout npm
  // produces is the whole basis of the distinction.
  const globalPrefix = join(temporaryRoot, "global-prefix");
  execFileSync("npm", ["install", "-g", "--prefix", globalPrefix, "--no-audit", "--no-fund", tarball], {
    cwd: temporaryRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });
  const globallyInstalled = join(globalPrefix, "lib/node_modules/@first-tree-ai/context-tree");
  const globalPostinstall = spawnSync(process.execPath, [join(globallyInstalled, "scripts/postinstall.mjs")], {
    cwd: temporaryRoot,
    encoding: "utf8",
    env: { ...npmEnvironment, npm_config_global: "true" },
  });
  assert.equal(globalPostinstall.status, 0, "postinstall must never fail an install");
  assert.match(globalPostinstall.stdout, /installed 6 skills for claude/u);
  for (const skill of SKILLS) {
    const installedSkill = join(temporaryRoot, ".claude", "skills", skill, "SKILL.md");
    assert.equal(lstatSync(installedSkill).isFile(), true, `postinstall must install ${skill}`);
    assert.equal(lstatSync(installedSkill).mode & 0o777, 0o644, `${skill} must be installed non-executable`);
    assert.equal(existsSync(join(temporaryRoot, ".claude", "skills", skill, "scripts")), false);
  }
  assert.equal(
    existsSync(join(temporaryRoot, ".codex")),
    false,
    "postinstall must not create an absent host directory",
  );

  const foreignSkill = join(temporaryRoot, ".claude", "skills", "foreign-skill");
  mkdirSync(foreignSkill);
  const contextTreeState = join(temporaryRoot, ".context-tree", "trees", "preserved");
  mkdirSync(contextTreeState, { recursive: true });
  const uninstall = runCli(join(globalPrefix, "bin/context-tree"), temporaryRoot, ["uninstall"]);
  assert.equal(uninstall.status, 0);
  assert.equal(uninstall.stdout.trim().split("\n").length, 1, "uninstall must print one JSON line");
  const uninstallResult = parseOneLineJson(uninstall.stdout);
  assert.deepEqual(uninstallResult.removed[0].skills, SKILLS);
  for (const skill of SKILLS) {
    assert.equal(existsSync(join(temporaryRoot, ".claude", "skills", skill)), false);
  }
  assert.equal(existsSync(foreignSkill), true, "uninstall must preserve foreign skills");
  assert.equal(existsSync(contextTreeState), true, "uninstall must preserve Context Tree state");
  assert.equal(existsSync(join(temporaryRoot, ".codex")), false, "uninstall must not create absent hosts");

  const cliPath = join(consumerRoot, "node_modules/.bin/context-tree");

  const help = runCli(cliPath, consumerRoot, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context-tree \[options\] \[command\]/u);

  const version = runCli(cliPath, consumerRoot, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${manifest.version}\n`);

  const created = runCli(cliPath, consumerRoot, ["create", "--project-path", ".", "--json"]);
  assert.equal(created.status, 0);
  const createdResult = parseOneLineJson(created.stdout);
  const treePath = createdResult.treePath;
  assert.match(createdResult.commitSha, /^[0-9a-f]{40}$/u, "create must report the scaffold commit");
  assert.equal(createdResult.pointer, "written", "create must record the tree in the project");

  // The project pointer replaces the retired session hook.
  const projectInstructions = readFileSync(join(consumerRoot, "AGENTS.md"), "utf8");
  assert.match(projectInstructions, /<!-- context-tree:begin -->/u);
  assert.equal(projectInstructions.includes(treePath), true, "the pointer must name the connected tree");
  assert.equal(readlinkSync(join(consumerRoot, "CLAUDE.md")), "AGENTS.md");

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

  const resolved = runCli(cliPath, consumerRoot, ["resolve", "--json"]);
  assert.equal(resolved.status, 0);
  assert.equal(parseOneLineJson(resolved.stdout).tree.path, treePath);

  // A project-scoped install is the re-run path, and must not need a host directory to exist.
  const projectInstall = runCli(cliPath, consumerRoot, ["install", "--host", "codex", "--project", "."]);
  assert.equal(projectInstall.status, 0);
  const projectInstallResult = parseOneLineJson(projectInstall.stdout);
  assert.equal(projectInstallResult.version, manifest.version);
  assert.deepEqual(
    projectInstallResult.installed.map((entry) => entry.host),
    ["codex"],
  );
  requirePackagedFile(consumerRoot, ".codex/skills/context-tree-write/SKILL.md");

  const validVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", treePath, "--json"]);
  assert.equal(validVerify.status, 0);
  assert.equal(parseOneLineJson(validVerify.stdout).ok, true);

  const read = runCli(cliPath, consumerRoot, ["read", "--tree-path", treePath, "--json"]);
  assert.equal(read.status, 0);
  assert.equal(parseOneLineJson(read.stdout).target, ".");

  rmSync(join(treePath, "NODE.md"));
  const invalidVerify = runCli(cliPath, consumerRoot, ["verify", "--tree-path", treePath, "--json"]);
  assert.equal(invalidVerify.status, 1);
  assert.equal(parseOneLineJson(invalidVerify.stdout).ok, false);
} finally {
  rmSync(temporaryRoot, { force: true, recursive: true });
}
