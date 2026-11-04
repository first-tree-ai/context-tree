import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, it, vi } from "vitest";

// Report selected paths as absent once, as if another process created them right after the check.
const raced = new Set<string>();
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  const lstatSync = ((path: string, options?: object) => {
    if (raced.delete(String(path))) return undefined;
    return actual.lstatSync(path, options as never);
  }) as typeof actual.lstatSync;
  return { ...actual, lstatSync, default: { ...actual, lstatSync } };
});
const { privateDirectory } = await import("../src/adapters/state.js");

const roots: string[] = [];
afterEach(() => {
  raced.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function root(): string {
  const path = mkdtempSync(join(tmpdir(), "ct-state-race-"));
  roots.push(path);
  return path;
}

it("accepts a state directory another process created after the existence check", () => {
  const home = root();
  const state = join(home, ".context-tree");
  mkdirSync(state, { mode: 0o700 });
  raced.add(state);
  expect(privateDirectory(join(state, "repositories"))).toContain("repositories");
  expect(statSync(join(state, "repositories")).isDirectory()).toBe(true);
});

it("still rejects a symlink another process placed after the existence check", () => {
  const home = root();
  const target = join(home, "elsewhere");
  mkdirSync(target);
  const state = join(home, ".context-tree");
  symlinkSync(target, state);
  raced.add(state);
  expect(() => privateDirectory(state)).toThrow(/symlink/u);
});
