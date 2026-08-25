import { type ParsedMarkdownFrontmatter, parseMarkdownFrontmatter } from "../../internal/frontmatter.js";
import { readUtf8File } from "./filesystem.js";

export type ContextDocument = ParsedMarkdownFrontmatter;

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

export function readContextDocument(path: string): ContextDocument {
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
