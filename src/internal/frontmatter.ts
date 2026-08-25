import { parse } from "yaml";

import { isRecord } from "./value.js";

export type ParsedMarkdownFrontmatter =
  | { body: string; data: null; error: string; frontmatter: "invalid" }
  | { body: string; data: null; frontmatter: "missing" }
  | { body: string; data: Record<string, unknown>; frontmatter: "valid" };

function parseYamlMapping(source: string): Record<string, unknown> {
  const value: unknown = parse(source);
  if (!isRecord(value)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return value;
}

type Line = {
  end: number;
  start: number;
  value: string;
};

function readLine(source: string, start: number): Line {
  const newline = source.indexOf("\n", start);
  const end = newline === -1 ? source.length : newline + 1;
  const contentEnd = newline === -1 ? source.length : source.charCodeAt(newline - 1) === 13 ? newline - 1 : newline;
  return { end, start, value: source.slice(start, contentEnd) };
}

export function parseMarkdownFrontmatter(source: string): ParsedMarkdownFrontmatter {
  const opening = readLine(source, 0);
  if (opening.value !== "---") {
    return { body: source, data: null, frontmatter: "missing" };
  }

  let closing: Line | undefined;
  let lineStart = opening.end;
  while (lineStart < source.length) {
    const line = readLine(source, lineStart);
    if (line.value === "---") {
      closing = line;
      break;
    }
    lineStart = line.end;
  }

  if (closing === undefined) {
    return {
      body: "",
      data: null,
      error: "frontmatter closing delimiter is missing",
      frontmatter: "invalid",
    };
  }

  const body = source.slice(closing.end);
  try {
    return {
      body,
      data: parseYamlMapping(source.slice(opening.end, closing.start)),
      frontmatter: "valid",
    };
  } catch (error) {
    return {
      body,
      data: null,
      error: error instanceof Error ? error.message : String(error),
      frontmatter: "invalid",
    };
  }
}
