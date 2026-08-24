import { readdirSync, readFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";

const SKILLS_ROOT = resolve(import.meta.dirname, "../skills");
const PACKAGE_MANIFEST = record(JSON.parse(readFileSync(resolve(import.meta.dirname, "../package.json"), "utf8")));

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Expected a mapping.");
  return Object.fromEntries(Object.entries(value));
}

function nonEmptyString(value: unknown): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error("Expected a non-empty string.");
  return value;
}

function skillDirectories(): string[] {
  return readdirSync(SKILLS_ROOT, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(SKILLS_ROOT, entry.name))
    .sort();
}

function splitSkill(source: string): { body: string; frontmatter: Record<string, unknown> } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/u.exec(source);
  if (!match?.[1]) throw new Error("SKILL.md must contain YAML frontmatter.");
  return { body: match[2] ?? "", frontmatter: record(parse(match[1])) };
}

describe("Agent Skills contracts", () => {
  it("ships only init, read, and write skills", () => {
    expect(skillDirectories().map((path) => basename(path))).toEqual([
      "context-tree-init",
      "context-tree-read",
      "context-tree-write",
    ]);
  });

  for (const directory of skillDirectories()) {
    const name = basename(directory);

    it(`${name} has valid portable metadata and a non-empty body`, () => {
      const source = readFileSync(join(directory, "SKILL.md"), "utf8");
      const skill = splitSkill(source);

      expect(Object.keys(skill.frontmatter).sort()).toEqual([
        "compatibility",
        "description",
        "license",
        "metadata",
        "name",
      ]);
      expect(skill.frontmatter.name).toBe(name);
      expect(nonEmptyString(skill.frontmatter.description)).toBe(skill.frontmatter.description);
      expect(skill.frontmatter.license).toBe("Apache-2.0");
      expect(skill.frontmatter.compatibility).toBe(
        "Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.",
      );
      expect(record(skill.frontmatter.metadata)).toEqual({
        author: "first-tree-ai",
        version: PACKAGE_MANIFEST.version,
      });
      expect(skill.body.trim()).not.toBe("");
    });

    it(`${name} has complete OpenAI UI metadata`, () => {
      const openai = record(parse(readFileSync(join(directory, "agents/openai.yaml"), "utf8")));
      const interfaceMetadata = record(openai.interface);

      expect(Object.keys(interfaceMetadata).sort()).toEqual(["default_prompt", "display_name", "short_description"]);
      for (const value of Object.values(interfaceMetadata)) {
        expect(nonEmptyString(value)).toBe(value);
      }
      expect(interfaceMetadata.default_prompt).toContain(`$${name}`);
    });
  }

  it("does not reference the retired shared memory namespace", () => {
    for (const directory of skillDirectories()) {
      const source = readFileSync(join(directory, "SKILL.md"), "utf8");
      expect(source).not.toContain("memory/");
    }
  });
});
