import matter from "gray-matter";
import { parse } from "yaml";

import { isRecord } from "./value.js";

export type ParsedMarkdownFrontmatter = {
  body: string;
  data: Record<string, unknown> | null;
  error?: string;
  frontmatter: "invalid" | "missing" | "valid";
};

export type ParseMarkdownFrontmatterOptions = {
  strictDelimiters?: boolean;
};

const STRICT_FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/u;
const PERMISSIVE_FRONTMATTER_RE = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|\s*$)([\s\S]*)$/u;

function parseYamlMapping(source: string): Record<string, unknown> {
  const value: unknown = parse(source);
  if (!isRecord(value)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return value;
}

const MATTER_OPTIONS = { engines: { yaml: parseYamlMapping } };

export function parseMarkdownFrontmatter(
  source: string,
  options: ParseMarkdownFrontmatterOptions = {},
): ParsedMarkdownFrontmatter {
  const pattern = options.strictDelimiters === true ? STRICT_FRONTMATTER_RE : PERMISSIVE_FRONTMATTER_RE;
  const match = pattern.exec(source);
  if (!matter.test(source) || match === null) {
    return { body: source, data: null, frontmatter: "missing" };
  }

  try {
    const parsed = matter(source, MATTER_OPTIONS);
    const data: unknown = parsed.data;
    if (!isRecord(data)) {
      return {
        body: parsed.content,
        data: null,
        error: "frontmatter must be a YAML mapping",
        frontmatter: "invalid",
      };
    }
    return { body: parsed.content, data, frontmatter: "valid" };
  } catch (error) {
    return {
      body: match[2] ?? "",
      data: null,
      error: error instanceof Error ? error.message : String(error),
      frontmatter: "invalid",
    };
  }
}
