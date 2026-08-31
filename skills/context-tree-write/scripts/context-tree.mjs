#!/usr/bin/env node

import { spawnSync } from "node:child_process";
import { lstatSync, readFileSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_NAME = "@first-tree-ai/context-tree";
const REINSTALL_MESSAGE = "Context Tree packaged CLI is unavailable. Reinstall or update the Context Tree plugin.";

function packagedCli() {
  try {
    const packageRoot = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), "../../.."));
    const packageJson = resolve(packageRoot, "package.json");
    const cli = resolve(packageRoot, "dist/cli/index.mjs");
    if (lstatSync(packageJson).isSymbolicLink() || !lstatSync(packageJson).isFile()) return undefined;
    if (JSON.parse(readFileSync(packageJson, "utf8")).name !== PACKAGE_NAME) return undefined;
    if (lstatSync(cli).isSymbolicLink() || !lstatSync(cli).isFile()) return undefined;
    const realCli = realpathSync(cli);
    const containedPath = relative(packageRoot, realCli);
    return containedPath !== "" && !containedPath.startsWith("..") && !isAbsolute(containedPath) ? realCli : undefined;
  } catch {
    return undefined;
  }
}

function forward(result) {
  if (result.error !== undefined) {
    process.stderr.write(`${REINSTALL_MESSAGE}\n`);
    process.exit(1);
  }
  if (result.signal !== null) process.kill(process.pid, result.signal);
  process.exit(result.status ?? 1);
}

const cli = packagedCli();
if (cli === undefined) {
  process.stderr.write(`${REINSTALL_MESSAGE}\n`);
  process.exit(1);
}
forward(spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: "inherit" }));
