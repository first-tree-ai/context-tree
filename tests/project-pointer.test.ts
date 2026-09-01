import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterEach, describe, expect, it } from "vitest";
import { writeProjectPointer } from "../src/core/internal/project-pointer.js";

const roots = new Set<string>();

function project(): string {
  const root = mkdtempSync(resolve(tmpdir(), "context-tree-pointer-"));
  roots.add(root);
  const path = join(root, "service");
  mkdirSync(path);
  return path;
}

function agents(path: string): string {
  return readFileSync(join(path, "AGENTS.md"), "utf8");
}

afterEach(() => {
  for (const root of roots) rmSync(root, { force: true, recursive: true });
  roots.clear();
});

describe("project pointer", () => {
  it("creates AGENTS.md and a CLAUDE.md symlink in a bare project", () => {
    const path = project();
    expect(writeProjectPointer(path, "/trees/service-context-tree")).toBe("written");
    expect(agents(path)).toContain("/trees/service-context-tree");
    expect(agents(path)).toContain("<!-- context-tree:begin -->");
    expect(lstatSync(join(path, "CLAUDE.md")).isSymbolicLink()).toBe(true);
    expect(readlinkSync(join(path, "CLAUDE.md"))).toBe("AGENTS.md");
  });

  it("appends to an existing AGENTS.md without disturbing its content", () => {
    const path = project();
    writeFileSync(join(path, "AGENTS.md"), "# AGENTS.md\n\n## House rules\n\nRun the linter.\n");
    expect(writeProjectPointer(path, "/trees/one")).toBe("written");
    const body = agents(path);
    expect(body).toContain("## House rules");
    expect(body).toContain("Run the linter.");
    expect(body).toContain("/trees/one");
  });

  it("leaves an existing regular CLAUDE.md alone", () => {
    const path = project();
    writeFileSync(join(path, "CLAUDE.md"), "# Project instructions\n");
    writeProjectPointer(path, "/trees/one");
    expect(lstatSync(join(path, "CLAUDE.md")).isSymbolicLink()).toBe(false);
    expect(readFileSync(join(path, "CLAUDE.md"), "utf8")).toBe("# Project instructions\n");
  });

  it("is idempotent and keeps exactly one block", () => {
    const path = project();
    expect(writeProjectPointer(path, "/trees/one")).toBe("written");
    expect(writeProjectPointer(path, "/trees/one")).toBe("skipped");
    expect(agents(path).match(/context-tree:begin/gu)).toHaveLength(1);
  });

  it("rewrites the block in place when the connected tree changes", () => {
    const path = project();
    writeProjectPointer(path, "/trees/one");
    expect(writeProjectPointer(path, "/trees/two")).toBe("updated");
    const body = agents(path);
    expect(body).toContain("/trees/two");
    expect(body).not.toContain("/trees/one");
    expect(body.match(/context-tree:begin/gu)).toHaveLength(1);
  });

  it("preserves surrounding content when rewriting the block", () => {
    const path = project();
    writeFileSync(join(path, "AGENTS.md"), "# AGENTS.md\n\n## Before\n\nkeep me\n");
    writeProjectPointer(path, "/trees/one");
    writeFileSync(join(path, "AGENTS.md"), `${agents(path)}\n## After\n\nkeep me too\n`);
    expect(writeProjectPointer(path, "/trees/two")).toBe("updated");
    const body = agents(path);
    expect(body).toContain("keep me");
    expect(body).toContain("keep me too");
    expect(body).toContain("/trees/two");
  });

  it("refuses to write through a symlinked AGENTS.md", () => {
    const path = project();
    const outside = join(path, "..", "outside.md");
    writeFileSync(outside, "# Outside\n");
    symlinkSync(outside, join(path, "AGENTS.md"), "file");
    expect(() => writeProjectPointer(path, "/trees/one")).toThrow(/symlink/u);
    expect(readFileSync(outside, "utf8")).toBe("# Outside\n");
  });

  it("refuses to write when AGENTS.md is a directory", () => {
    const path = project();
    mkdirSync(join(path, "AGENTS.md"));
    expect(() => writeProjectPointer(path, "/trees/one")).toThrow(/symlink or non-file/u);
  });
});
