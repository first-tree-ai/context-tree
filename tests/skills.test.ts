import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";
import { parse } from "yaml";
import { z } from "zod";

const root = resolve(import.meta.dirname, "../skills");
it("packages valid, portable skills and matching host metadata", () => {
  const names = readdirSync(root).sort();
  expect(names.length).toBeGreaterThan(0);
  for (const name of names) {
    const source = readFileSync(join(root, name, "SKILL.md"), "utf8");
    const frontmatter = z
      .object({ name: z.literal(name), description: z.string().min(1).max(1024) })
      .parse(parse(source.split("---")[1] ?? ""));
    expect(frontmatter.description).not.toMatch(/[<>]/);
    const metadata = z
      .object({
        interface: z.object({
          display_name: z.string(),
          short_description: z.string().min(25).max(64),
          default_prompt: z.string(),
        }),
      })
      .parse(parse(readFileSync(join(root, name, "agents/openai.yaml"), "utf8")));
    expect(metadata.interface.default_prompt).toContain(`$${name}`);
    expect(source).not.toMatch(/\/Users\/|\.codex\/worktrees\//);
  }
});
