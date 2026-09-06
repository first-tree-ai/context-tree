import fs, {
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
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { linkProjectInstructions } from "../src/core/internal/project-instructions.js";

const roots: string[] = [];
function project(): string {
  const root = mkdtempSync(join(tmpdir(), "context-tree-instructions-"));
  roots.push(root);
  return root;
}
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
describe("project instruction discovery", () => {
  it("links regular instructions without changing their bytes", () => {
    const root = project();
    const bytes = Buffer.from("# Rules\r\nKeep everything.\n");
    writeFileSync(join(root, "AGENTS.md"), bytes);
    linkProjectInstructions(root);
    linkProjectInstructions(root);
    expect(readFileSync(join(root, "AGENTS.md"))).toEqual(bytes);
    expect(readlinkSync(join(root, "CLAUDE.md"))).toBe("AGENTS.md");
  });
  it.each(["absent", "directory", "symlink", "dangling"])("skips %s AGENTS.md", (kind) => {
    const root = project();
    const path = join(root, "AGENTS.md");
    if (kind === "directory") mkdirSync(path);
    if (kind === "symlink") {
      writeFileSync(join(root, "rules"), "rules");
      symlinkSync("rules", path);
    }
    if (kind === "dangling") symlinkSync("missing", path);
    linkProjectInstructions(root);
    expect(lstatSync(join(root, "CLAUDE.md"), { throwIfNoEntry: false })).toBeUndefined();
  });
  it.each(["file", "directory", "symlink", "dangling"])("preserves existing CLAUDE.md %s", (kind) => {
    const root = project();
    writeFileSync(join(root, "AGENTS.md"), "rules");
    const path = join(root, "CLAUDE.md");
    if (kind === "file") writeFileSync(path, "custom");
    if (kind === "directory") mkdirSync(path);
    if (kind === "symlink") symlinkSync("AGENTS.md", path);
    if (kind === "dangling") symlinkSync("missing", path);
    const before = lstatSync(path);
    linkProjectInstructions(root);
    expect(lstatSync(path)).toEqual(before);
  });
  it("tolerates link creation failure", () => {
    const root = project();
    writeFileSync(join(root, "AGENTS.md"), "rules");
    vi.spyOn(fs, "symlinkSync").mockImplementation(() => {
      throw new Error("denied");
    });
    expect(() => linkProjectInstructions(root)).not.toThrow();
  });
});
