// Propagates package.json's version into every skills/*/SKILL.md frontmatter.
//
// tests/skills.test.ts asserts `metadata.version` equals the package version,
// so the two must move together. Release automation rewrites package.json on
// the runner and then calls this script; run it manually after a local bump.
//
// Usage:
//   node scripts/sync-skill-versions.mjs           rewrite SKILL.md in place
//   node scripts/sync-skill-versions.mjs --check   report drift, exit 1, write nothing

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";

const projectRoot = resolve(import.meta.dirname, "..");
const skillsRoot = join(projectRoot, "skills");
const checkOnly = process.argv.includes("--check");

// Mirrors splitSkill() in tests/skills.test.ts: frontmatter is the block
// between the leading `---` fence and the next one.
const FRONTMATTER = /^---\n([\s\S]*?)\n---\n/u;
const VERSION_LINE = /^([ \t]*)version:[ \t]*.*$/gmu;

const { version } = JSON.parse(readFileSync(join(projectRoot, "package.json"), "utf8"));
if (typeof version !== "string" || version.length === 0) {
  throw new Error("package.json is missing a version.");
}

const skillFiles = readdirSync(skillsRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => join(skillsRoot, entry.name, "SKILL.md"))
  .sort();

if (skillFiles.length === 0) throw new Error(`No skills found under ${skillsRoot}.`);

const drifted = [];

for (const file of skillFiles) {
  const source = readFileSync(file, "utf8");
  const frontmatter = FRONTMATTER.exec(source)?.[1];
  if (frontmatter === undefined) throw new Error(`${file} must contain YAML frontmatter.`);

  // Rewrite only inside the frontmatter so a `version:` in prose stays untouched.
  const matches = [...frontmatter.matchAll(VERSION_LINE)];
  if (matches.length !== 1) {
    throw new Error(`${file} frontmatter must declare exactly one version key, found ${matches.length}.`);
  }

  const updated = frontmatter.replace(VERSION_LINE, (_line, indent) => `${indent}version: "${version}"`);
  if (updated === frontmatter) continue;

  drifted.push(basename(resolve(file, "..")));
  if (!checkOnly) writeFileSync(file, source.replace(frontmatter, updated));
}

if (drifted.length === 0) {
  console.log(`All ${skillFiles.length} skills already declare version ${version}.`);
  process.exit(0);
}

if (checkOnly) {
  console.error(`Skill version drift from package.json ${version}: ${drifted.join(", ")}`);
  console.error("Run `node scripts/sync-skill-versions.mjs` to fix.");
  process.exit(1);
}

console.log(`Set version ${version} on ${drifted.length} skill(s): ${drifted.join(", ")}`);
