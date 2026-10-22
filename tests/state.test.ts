import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { withAsyncLock, withLock } from "../src/adapters/state.js";
import { connect } from "../src/operations/connections.js";
import { syncTrees } from "../src/operations/trees.js";
import { identityId } from "../src/sources/identity.js";
import { remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();

it("reclaims an interrupted owner's cache lock and reuses the downloaded repository", async () => {
  const { home, project } = fixture();
  const { runner, calls } = remoteFixture(home);
  const source = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;
  connect(project, source);
  expect(syncTrees(project, undefined, false, runner).connections[0]?.ok).toBe(true);
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
  await once(child, "spawn");
  const lock = join(home, ".context-tree", "repositories", `${identityId(source.repository)}.git.lock`);
  mkdirSync(lock);
  writeFileSync(join(lock, `${child.pid}.abcd`), "");
  expect(syncTrees(project, undefined, false, runner).connections[0]).toMatchObject({
    ok: false,
    error: { code: "BUSY" },
  });
  const closed = once(child, "close");
  child.kill("SIGKILL");
  await closed;
  expect(syncTrees(project, undefined, false, runner).connections[0]?.ok).toBe(true);
  expect(calls.filter((args) => args.includes("clone"))).toHaveLength(1);
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
