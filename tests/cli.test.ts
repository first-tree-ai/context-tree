import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runContextTreeCli } from "../src/cli/api.js";
import { finishWriteResultSchema, resolveResultSchema, writeSessionSchema } from "../src/contracts/index.js";
import { useFixture } from "./helpers.js";

const fixture = useFixture();
async function cli(args: string[], cwd = fixture().project): Promise<{ status: number; out: string; err: string }> {
  let out = "";
  let err = "";
  const status = await runContextTreeCli(["node", "context-tree", ...args], {
    cwd: () => cwd,
    stdout: (text) => {
      out += text;
    },
    stderr: (text) => {
      err += text;
    },
  });
  return { status, out, err };
}
describe("CLI contracts", () => {
  it("runs the directory lifecycle without Git and uses the public wire schemas", async () => {
    const { project } = fixture();
    const initialized = await cli(["init", "docs", "--json"]);
    expect(initialized.status).toBe(0);
    expect(JSON.parse(initialized.out).treeRoot).toBe(join(project, "docs"));
    expect(existsSync(join(project, ".git"))).toBe(false);
    const synced = await cli(["sync"]);
    expect(synced.err).toBe("");
    expect(synced.out.trim().split("\n")).toHaveLength(1);
    expect(resolveResultSchema.parse(JSON.parse(synced.out)).connections[0]?.ok).toBe(true);
    expect((await cli(["read"])).out).toContain("Durable context");
    const session = writeSessionSchema.parse(JSON.parse((await cli(["prepare-write"])).out));
    writeFileSync(join(session.treeRoot, "decision.md"), "---\ntitle: Decision\n---\nUse directories.\n");
    const finished = await cli(["finish-write", session.id]);
    expect(finishWriteResultSchema.parse(JSON.parse(finished.out)).outcome).toBe("validated");
    expect((await cli(["verify", "--json"])).status).toBe(0);
    expect((await cli(["disconnect", "--json"])).status).toBe(0);
    expect(existsSync(join(project, "docs/NODE.md"))).toBe(true);
    expect(JSON.parse((await cli(["resolve", "--json"])).out).error.code).toBe("NO_CONNECTION");
  });
  it("requires selection for multiple trees and discovers config from nested directories", async () => {
    await cli(["init", "docs"]);
    await cli(["init", "team"]);
    const child = join(fixture().project, "src");
    mkdirSync(child);
    expect((await cli(["read"], child)).err).toContain("--tree");
    expect((await cli(["read", "--tree", "team"], child)).status).toBe(0);
    const all = await cli(["resolve", "--json"], child);
    expect(JSON.parse(all.out).connections).toHaveLength(2);
  });
  it("reports failures on the right channel and never accepts removed commands", async () => {
    const missing = await cli(["read"]);
    expect(missing.status).toBe(1);
    expect(missing.out).toBe("");
    expect(missing.err).toContain("context-tree:");
    const machine = await cli(["prepare-write"]);
    expect(machine.err).toBe("");
    expect(JSON.parse(machine.out).error.code).toBe("NO_CONNECTION");
    for (const name of ["create", "publish", "list"]) expect((await cli([name, "--json"])).status).toBe(1);
    const invalid = await cli(["connect", "acme/repo", "--json"]);
    expect(invalid.status).toBe(1);
    expect(JSON.parse(invalid.out).ok).toBe(false);
    expect((await cli(["--help"])).status).toBe(0);
    expect((await cli(["init", "docs", "--as", "custom", "--json"])).status).toBe(1);
    expect((await cli(["connect", "--as", "custom", "--json"])).status).toBe(1);
    expect((await cli(["read", "--json"])).status).toBe(1);
  });
  it("verifies direct content without needing a project connection", async () => {
    await cli(["init", "docs"]);
    const root = join(fixture().project, "docs");
    const node = readFileSync(join(root, "NODE.md"), "utf8");
    writeFileSync(join(root, "NODE.md"), node.replace("schemaVersion: 1", "schemaVersion: 3"));
    const result = await cli(["verify", "--tree-path", root, "--json"], fixture().home);
    expect(result.status).toBe(1);
    expect(JSON.parse(result.out).ok).toBe(false);
  });
});
