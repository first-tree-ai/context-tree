import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { git } from "../src/adapters/git.js";
import { connectTree, syncTrees } from "../src/operations/trees.js";
import { abortWrite, prepareWrite } from "../src/operations/write.js";
import { FETCH_FRESHNESS_MS } from "../src/sources/resolve.js";
import { commit, node, remoteFixture, useFixture } from "./helpers.js";

const fixture = useFixture();
const source = { kind: "git", repository: "acme/context", path: "docs", ref: "main" } as const;

function advance(seed: string, remote: string, title: string): void {
  writeFileSync(join(seed, `docs/${title.toLowerCase()}.md`), node(title));
  commit(seed);
  git(seed, ["push", remote, "main"]);
}

describe("fetch freshness window", () => {
  it("reuses a recent fetch, honors --max-age 0, and fetches again after the window", () => {
    const { project, home } = fixture();
    const { runner, seed, remote, calls } = remoteFixture(home);
    const first = connectTree(project, source, runner).repository?.sha;
    const fetches = (): number => calls.filter((args) => args.includes("fetch")).length;
    const before = fetches();
    advance(seed, remote, "Second");

    const reused = syncTrees(project, undefined, false, runner).connections[0];
    expect(fetches()).toBe(before);
    expect(reused?.ok && reused.repository?.sha).toBe(first);

    const forced = syncTrees(project, undefined, false, runner, 0).connections[0];
    expect(fetches()).toBe(before + 1);
    expect(forced?.ok && forced.repository?.sha).not.toBe(first);

    advance(seed, remote, "Third");
    const repositories = join(home, ".context-tree/repositories");
    const record = join(repositories, readdirSync(repositories).find((name) => name.endsWith(".fetched.json")) ?? "");
    const expiredAt = Date.now() - FETCH_FRESHNESS_MS - 1;
    const refs = Object.keys(JSON.parse(readFileSync(record, "utf8")));
    writeFileSync(record, JSON.stringify(Object.fromEntries(refs.map((ref) => [ref, expiredAt]))));
    const expired = syncTrees(project, undefined, false, runner).connections[0];
    expect(fetches()).toBe(before + 2);
    expect(expired?.ok && expired.repository?.sha).toBe(git(remote, ["rev-parse", "main"]));
  });

  it("always fetches before preparing a write", () => {
    const { project, home } = fixture();
    const { runner, seed, remote } = remoteFixture(home);
    connectTree(project, source, runner);
    advance(seed, remote, "Second");
    const session = prepareWrite(project, undefined, runner);
    expect(readFileSync(join(session.treeRoot, "second.md"), "utf8")).toContain("Second");
    abortWrite(session.id, runner);
  });
});
