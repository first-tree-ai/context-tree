import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultRunner, git } from "../src/adapters/git.js";

it("bounds a stalled command and reports a useful timeout", () => {
  const result = defaultRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toContain("timed out");
});

it.skipIf(process.platform === "win32")("kills descendants of a timed-out command", async () => {
  const directory = mkdtempSync(join(tmpdir(), "context-tree-command-"));
  const heartbeat = join(directory, "heartbeat");
  try {
    const child = `require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'); setInterval(() => require('node:fs').appendFileSync(${JSON.stringify(heartbeat)}, '.'), 20);`;
    const result = defaultRunner(
      process.execPath,
      [
        "-e",
        `require('node:child_process').spawn(process.execPath, ['-e', ${JSON.stringify(child)}], {stdio: 'inherit'});`,
      ],
      1000,
    );
    expect(result.stderr).toContain("timed out");
    await new Promise((resolve) => setTimeout(resolve, 100));
    const contents = readFileSync(heartbeat, "utf8");
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(readFileSync(heartbeat, "utf8")).toBe(contents);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

it("includes useful failure details without exposing credentials or command arguments", () => {
  const token = "ghp_abcdefghijklmnopqrstuvwxyz123456";
  const runner = () => ({
    status: 128,
    stdout: "",
    stderr: `denied https://user:password@github.com/acme/tree.git Authorization: Bearer ${token}`,
  });
  try {
    git("/unused", ["fetch", "private-argument"], { runner, message: "Fetch failed" });
    expect.unreachable("A failed command must throw");
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    expect(error.message).toContain("Fetch failed");
    expect(error.message).toContain("denied");
    for (const secret of [token, "user:password", "private-argument"]) expect(error.message).not.toContain(secret);
  }
});
