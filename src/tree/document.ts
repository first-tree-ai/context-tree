import { readFileSync } from "node:fs";
import { parse } from "yaml";

export type ParsedMarkdownFrontmatter =
  | { body: string; data: null; error: string; frontmatter: "invalid" }
  | { body: string; data: null; frontmatter: "missing" }
  | { body: string; data: Record<string, unknown>; frontmatter: "valid" };

function parseYamlMapping(source: string): Record<string, unknown> {
  const value: unknown = parse(source);
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("frontmatter must be a YAML mapping");
  }
  return Object.fromEntries(Object.entries(value));
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

export function readUtf8File(path: string): string {
  return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path));
}

type ParsedNodeDocument = {
  body: string;
  frontmatter: Record<string, unknown>;
  description?: string;
  title: string;
};

type ContextField<T> =
  | { present: false; valid: false }
  | { present: true; valid: false }
  | { present: true; valid: true; value: T };

export function readContextDocument(path: string): ParsedMarkdownFrontmatter {
  try {
    return parseMarkdownFrontmatter(readUtf8File(path));
  } catch (error) {
    return {
      body: "",
      data: null,
      error: error instanceof Error ? error.message : String(error),
      frontmatter: "invalid",
    };
  }
}

export function readNonEmptyStringField(data: Record<string, unknown>, key: string): ContextField<string> {
  if (!(key in data)) {
    return { present: false, valid: false };
  }

  const value = data[key];
  if (typeof value !== "string" || value.trim().length === 0) {
    return { present: true, valid: false };
  }

  return { present: true, valid: true, value: value.trim() };
}

export function readNonEmptyStringArrayField(data: Record<string, unknown>, key: string): ContextField<string[]> {
  if (!(key in data)) {
    return { present: false, valid: false };
  }

  const value = data[key];
  if (!Array.isArray(value) || value.length === 0) {
    return { present: true, valid: false };
  }

  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string" || item.trim().length === 0) {
      return { present: true, valid: false };
    }
    items.push(item.trim());
  }

  return { present: true, valid: true, value: items };
}

export function readNodeDocument(path: string): ParsedNodeDocument | null {
  const document = readContextDocument(path);
  if (document.frontmatter !== "valid") {
    return null;
  }

  const title = readNonEmptyStringField(document.data, "title");
  const description = readNonEmptyStringField(document.data, "description");

  if (!title.valid || (description.present && !description.valid)) {
    return null;
  }

  return {
    body: document.body,
    frontmatter: document.data,
    title: title.value,
    ...(description.valid ? { description: description.value } : {}),
  };
}
