import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withAsyncLock, withLock, withLockWait } from "../src/adapters/state.js";
import { connect } from "../src/operations/connections.js";
import { syncTrees } from "../src/operations/trees.js";
import { identityId } from "../src/sources/identity.js";
import { remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();

it("waits for a live cache lock owner, then reclaims its lock and reuses the downloaded repository", async () => {
  const { home, project } = fixture();
  const { runner, calls } = remoteFixture(home);
  const source = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;
  connect(project, source);
  expect(syncTrees(project, undefined, false, runner).connections[0]?.ok).toBe(true);
  // A detached grandchild is reaped by init when it exits, so its PID stops being live.
  const child = spawn("sh", ["-c", "sleep 1.5 >/dev/null 2>&1 & echo $!"], { stdio: ["ignore", "pipe", "ignore"] });
  const [output] = await once(child.stdout, "data");
  const owner = String(output).trim();
  const lock = join(home, ".context-tree", "repositories", `${identityId(source.repository)}.git.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, `${owner}.abcd`), "");
  const started = Date.now();
  expect(syncTrees(project, undefined, false, runner, 0).connections[0]?.ok).toBe(true);
  expect(Date.now() - started).toBeGreaterThanOrEqual(1000);
  expect(calls.filter((args) => args.includes("clone"))).toHaveLength(1);
});

it("reports a live owner as busy once the lock wait expires", async () => {
  const path = join(fixture().project, "wait.lock");
  await withAsyncLock(path, async () => {
    expect(() => withLockWait(path, () => undefined, 300)).toThrow(/Another operation/);
  });
  expect(withLockWait(path, () => "acquired", 300)).toBe("acquired");
});

it("keeps live owners exclusive and releases locks on thrown failures", async () => {
  const path = join(fixture().project, "state.lock");
  mkdirSync(path); // An interrupted release can leave an empty directory.
  await withAsyncLock(path, async () => {
    expect(() => withLock(path, () => undefined)).toThrow(/Another operation/);
  });
  expect(() =>
    withLock(path, () => {
      throw new Error("failure");
    }),
  ).toThrow("failure");
  expect(withLock(path, () => "released")).toBe("released");
});

it("restarts an interrupted clone without adopting its incomplete staging directory", () => {
  const { home, project } = fixture();
  const { runner } = remoteFixture(home);
  const staging = join(home, ".context-tree", "repositories", `${identityId("acme/context")}.git.clone`);
  mkdirSync(staging, { recursive: true });
  writeFileSync(join(staging, "partial-download"), "incomplete");
  connect(project, { kind: "git", repository: "acme/context", path: "docs", ref: "main" });
  expect(syncTrees(project, undefined, false, runner).connections[0]?.ok).toBe(true);
  expect(existsSync(staging)).toBe(false);
});
