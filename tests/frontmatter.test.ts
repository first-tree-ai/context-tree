import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { readContextDocument } from "../src/core/internal/context-document.js";
import { parseContextTreeRootNode } from "../src/core/internal/root-node.js";
import { parseMarkdownFrontmatter } from "../src/internal/frontmatter.js";

const temporaryRoots = new Set<string>();

afterEach(() => {
  for (const root of temporaryRoots) rmSync(root, { force: true, recursive: true });
  temporaryRoots.clear();
});

describe("Markdown frontmatter", () => {
  it.each(["\n", "\r\n"])("accepts exact delimiters with %j line endings", (newline) => {
    expect(parseMarkdownFrontmatter(`---${newline}title: Node${newline}---${newline}Body`)).toEqual({
      body: "Body",
      data: { title: "Node" },
      frontmatter: "valid",
    });
  });

  it.each([" ", "\t"])("rejects delimiter lines containing %j", (whitespace) => {
    for (const malformedDelimiter of [`${whitespace}---`, `---${whitespace}`]) {
      const opening = `${malformedDelimiter}\ntitle: Node\n---\nBody`;
      expect(parseMarkdownFrontmatter(opening)).toEqual({ body: opening, data: null, frontmatter: "missing" });

      const closing = `---\ntitle: Node\n${malformedDelimiter}\nBody`;
      expect(parseMarkdownFrontmatter(closing)).toEqual({
        body: "",
        data: null,
        error: "frontmatter closing delimiter is missing",
        frontmatter: "invalid",
      });

      expect(() => parseContextTreeRootNode(opening)).toThrow(/must contain YAML frontmatter/u);
      expect(() => parseContextTreeRootNode(closing)).toThrow(/closing delimiter is missing/u);
    }
  });

  it("preserves the exact body after the closing delimiter", () => {
    expect(parseMarkdownFrontmatter("---\r\ntitle: Node\r\n---\r\n\r\nBody\r\n")).toEqual({
      body: "\r\nBody\r\n",
      data: { title: "Node" },
      frontmatter: "valid",
    });
    expect(parseMarkdownFrontmatter("---\ntitle: Node\n---")).toEqual({
      body: "",
      data: { title: "Node" },
      frontmatter: "valid",
    });
  });

  it("distinguishes missing and unterminated frontmatter", () => {
    const missing = "title: Node\nBody";
    expect(parseMarkdownFrontmatter(missing)).toEqual({ body: missing, data: null, frontmatter: "missing" });
    expect(parseMarkdownFrontmatter("---\ntitle: Node\nBody")).toEqual({
      body: "",
      data: null,
      error: "frontmatter closing delimiter is missing",
      frontmatter: "invalid",
    });
  });

  it("rejects empty, non-mapping, and malformed YAML while retaining the extracted body", () => {
    for (const source of ["", "   ", "scalar", "- one\n- two", "title: [unterminated"]) {
      expect(parseMarkdownFrontmatter(`---\n${source}\n---\nBody`)).toMatchObject({
        body: "Body",
        data: null,
        error: expect.any(String),
        frontmatter: "invalid",
      });
    }
  });

  it("reports invalid UTF-8 as an invalid document", () => {
    const root = mkdtempSync(join(tmpdir(), "context-tree-frontmatter-"));
    temporaryRoots.add(root);
    const path = join(root, "invalid.md");
    writeFileSync(path, Buffer.from([0xff, 0xfe]));
    expect(readContextDocument(path)).toMatchObject({ body: "", data: null, frontmatter: "invalid" });
  });
});
