import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const temporaryRoot = mkdtempSync(join(tmpdir(), "context-tree-package-e2e-"));
const npmEnvironment = { ...process.env, npm_config_cache: join(temporaryRoot, "npm-cache") };

function runCli(cliPath, cwd, args) {
  const result = spawnSync(cliPath, args, { cwd, encoding: "utf8" });
  assert.equal(result.signal, null, `CLI was terminated by ${result.signal ?? "an unknown signal"}`);
  return result;
}

function parseWithInstalledSchema(consumerRoot, schemaName, json) {
  execFileSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import { ${schemaName} } from "@first-tree-ai/context-tree"; ${schemaName}.parse(JSON.parse(process.argv[1]));`,
      json,
    ],
    { cwd: consumerRoot, stdio: "pipe" },
  );
}

try {
  execFileSync("npm", ["pack", "--silent", "--pack-destination", temporaryRoot], {
    cwd: projectRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });
  const tarballs = readdirSync(temporaryRoot).filter((name) => name.endsWith(".tgz"));
  assert.equal(tarballs.length, 1, "npm pack must create exactly one tarball");

  const consumerRoot = join(temporaryRoot, "consumer");
  mkdirSync(consumerRoot);
  writeFileSync(
    join(consumerRoot, "package.json"),
    '{"name":"context-tree-package-e2e","private":true,"type":"module"}\n',
  );
  execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", join(temporaryRoot, tarballs[0])], {
    cwd: consumerRoot,
    env: npmEnvironment,
    stdio: "pipe",
  });

  const manifest = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
  const cliPath = join(consumerRoot, "node_modules/.bin/context-tree");

  const help = runCli(cliPath, consumerRoot, ["--help"]);
  assert.equal(help.status, 0);
  assert.match(help.stdout, /context-tree \[options\] \[command\]/u);

  const version = runCli(cliPath, consumerRoot, ["--version"]);
  assert.equal(version.status, 0);
  assert.equal(version.stdout, `${manifest.version}\n`);

  const init = runCli(cliPath, consumerRoot, [
    "init",
    "--repository",
    "acme/context",
    "--tree-path",
    "tree",
    "--title",
    "Package E2E",
  ]);
  assert.equal(init.status, 0);
  parseWithInstalledSchema(consumerRoot, "scaffoldTreeResultSchema", init.stdout);

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
