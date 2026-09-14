import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { defaultRunner } from "../src/core/internal/git.js";

it("bounds a stalled command and reports a useful timeout", () => {
  const started = Date.now();
  const result = defaultRunner(process.execPath, ["-e", "setInterval(() => {}, 1000)"], 100);
  expect(result.status).not.toBe(0);
  expect(result.stderr).toBe("Command timed out after 100 ms.");
  expect(Date.now() - started).toBeLessThan(5000);
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
