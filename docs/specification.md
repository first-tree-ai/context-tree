# Context Tree lifecycle specification

## Scope

The package exposes setup as an orchestration skill over five concrete user
intentions: create, connect, read, write, and publish. A separate cleanup skill
performs conservative editorial maintenance through the same write lifecycle.
`install` is the distribution entry point. Supporting commands (`resolve`, `sync`, `list`,
`prepare-write`, `finish-write`, and `verify`) are integration plumbing. Every
JSON contract is strict and uses `schemaVersion: 1`.

## Shared invariants

- Every core Git and GitHub subprocess uses one injectable runner. Errors redact
  credential-bearing URLs, authorization values, and common GitHub token forms.
- Repository arguments are validated `OWNER/REPO` identities. Credential-bearing
  repository URLs are rejected and never logged.
- A Git project canonicalizes to the exact current checkout root. Separate
  clones and worktrees remain separate projects.
- A non-Git project connection matches only its exact canonical directory.
- Tree validation rejects symlink components, requires an exact clean Git root,
  parses the root node, and requires full tree verification to succeed. An
  unclean checkout is `DIRTY_TREE` and failed verification is `INVALID_TREE`;
  neither is reported as a stale connection.
- Stored `local` or `github` state remains that kind after connection; every
  selected managed checkout is classified from a safe origin before storage.
- Duplicate records for one project produce `CORRUPT_CONNECTION`.
- Connections are persisted by an atomic replacement with mode `0600`. No
  locking or schema migration is provided.

## Result contracts

```ts
type Create = {
  created: boolean; title: string; treePath: string; branch: string;
  commitSha: string; schemaVersion: 1;
};

type Tree =
  | { kind: "local"; path: string }
  | { kind: "github"; path: string; repository: string };

type Connection = { tree: Tree; schemaVersion: 1 };
type ManagedTreeListing = {
  schemaVersion: 1;
  trees: Array<{ name: string; tree: Tree }>;
};
type Sync = { tree: Tree; branch: string; sha: string; schemaVersion: 1 };
type Prepare = { worktreePath: string; schemaVersion: 1 };
type Finish = { branch: string; sha: string; schemaVersion: 1 };
type Publish = {
  repository: string; url: string; branch: string; sha: string;
  schemaVersion: 1;
};
```

Errors use `{ ok: false, error: { code, message }, schemaVersion: 1 }`.
Lifecycle-specific codes are `NO_CONNECTION`, `CORRUPT_CONNECTION`,
`STALE_CONNECTION`, `DIRTY_TREE`, `INVALID_TREE`, `WRITE_OUTDATED`,
`GITHUB_AUTH`, `REPOSITORY_EXISTS`, and `PUBLISH_INCOMPLETE`. Other failures
use `CONTEXT_TREE_FAILED`.

## Creation and connection

`create` derives `<normalized-project-directory>-context-tree` from the
canonical project root. It scaffolds and commits the tree in the flat managed
namespace before atomically connecting it. Repetition is idempotent only when
the project is still connected to that tree. An occupied name otherwise fails
with guidance to use `connect <name>`, and a project already connected to a
different tree fails rather than being silently repointed. Files created by a
failed create are removed; a destination that existed before the invocation is
never removed.

`connect <name>` performs an exact managed-directory lookup. `connect
OWNER/REPO` reuses a matching checkout or clones it under the lowercased
repository name. Every selection is validated and safely classified as local
or GitHub state. Local-tree, repository, and unsafe-origin name collisions fail
before the project connection changes. Explicit connection switches are
automatic. Only a directory created by a failed clone is removed.

`connect --tree-path <path>` attaches an exact, clean, fully valid Git root
with no symlink components in place and never copies, moves, or deletes it.
Trees without an origin classify as local state; credential-free GitHub
origins classify as GitHub state; all other origins are rejected. Stored-
connection validation accepts verified external paths while name-based
discovery remains restricted to the managed namespace. `list` reports valid,
clean managed trees as `{ schemaVersion: 1, trees: [{ name, tree }] }`; a
missing managed directory is an empty list and is never created by listing.

## Synchronization and reading

Local synchronization makes no network call and reports the checked-out branch
and exact `HEAD`. GitHub synchronization performs exactly one
`git pull --ff-only origin <checked-out-branch>`, revalidates, then reports its
exact SHA. It does not discover or enforce the remote default branch and does
not report an `updated` flag.

`read` returns a selected node and only its immediate indexed children. Ordinary
readers navigate narrowly from indexes; cleanup recursively visits all normal
children.

## Writing

`prepare-write` synchronizes and creates a random `context-tree/write/*` branch
in an isolated worktree at the synchronized SHA. It returns only the worktree
path and schema version; no token, registry, manifest, lock, or preparation
record exists.

`finish-write` requires that the supplied path is a real non-symlink directory,
belongs to the connected tree's Git common directory, uses the reserved branch
prefix, contains pending changes, and verifies as a complete Context Tree.
Calling it authorizes all pending changes. It stages everything and creates one
commit with `commit.gpgsign=false` while retaining the host Git identity.

For local state it attempts one fast-forward merge into the connected checkout's
current branch. For GitHub state it attempts one non-force push to that branch.
Success removes the worktree and task branch. A non-fast-forward failure emits
`WRITE_OUTDATED` and preserves both. There is no rebase, race loop, semantic
conflict result, or pull-request fallback.

Before creating its worktree, `prepare-write` reclaims earlier preparations that
were never finished. Every reclamation step is best effort and no failure among
them blocks the write. A reserved branch is removed, with its worktree when one
is still registered, only when it holds no commit the connected checkout lacks,
its worktree reports no pending change, and that worktree has gone untouched for
twenty-four hours. Any unknown answer preserves the worktree. Because
`finish-write` commits before it merges or pushes, a `WRITE_OUTDATED` worktree
holds an unmerged commit and is never reclaimed, so the documented retry keeps
its preserved edits. Reclamation is silent: `prepare-write` still returns only
the worktree path and schema version.

The write skill may prepare fresh and reapply the intended semantic change
once after `WRITE_OUTDATED`, after rereading affected nodes and their placement
in the fresh worktree. It adapts to moved or consolidated content rather than
replaying a rejected patch. A second outdated result is reported to the user.

## Cleanup

`context-tree-cleanup` resolves a stable absolute project path, prepares a fresh
worktree, and completes recursive `read --json` inspection of all normal indexed
content before editing. Member content and infrastructure are excluded from
editorial inspection and edits. It removes clearly non-durable noise,
consolidates duplicates without losing unique rationale or qualifications, and
moves misplaced content to the narrowest suitable existing domain. It updates
indexes and incoming and outgoing links, retaining the original location if
excluded content would need edits. It avoids cosmetic changes, invented
choices, new top-level domains, and structure without retrieval benefit.
Uncertain claims survive; contradictions are reported without source-repository
investigation. `decisionLocksCode` meaning and scope and human `lastReviewed`
metadata are preserved.

An invocation authorizes that bounded pass and publication, including subsequent
host-scheduled invocations without per-run approval. Edits stay exclusively in
the prepared worktree. An empty pass stops without `finish-write`. Otherwise the
skill runs `verify --json`, corrects only problems it introduced, and calls
`finish-write` once. It reports the SHA or failure and preserved worktree path
outside the tree. On `WRITE_OUTDATED`, it stops until a later invocation, which
reassesses from scratch instead of replaying the patch. Other failures stop
without automatic setup, repair, or credential changes.

Existing fast-forward/non-force publication protects intervening writes but
cannot guarantee progress during sustained activity. One designated cleaner per
tree avoids wasted competing passes. Existing worktree retention applies:
successes are removed, empty preparations are eligible after 24 hours, and
rejected commits stay recoverable and may need manual housekeeping.

Scheduling is entirely host-owned; start daily with the reusable prompt in
[README](../README.md#cleanup-and-scheduling). Claude Code supports skill invocation
through session-limited `/loop` and persistent scheduling options; Codex supports
skill invocation in scheduled tasks. OpenTag uses one already-connected agent
workspace and its existing packaged-skill discovery after upgrading its pinned
dependency. Automatic OpenTag scheduling is outside v1. Cleanup adds no CLI
commands, wire schemas, locks, scheduler, or runtime changes.

## Publication

`publish` requires stored local state, a clean valid tree, and no existing
`origin`. By default it combines the authenticated GitHub login with the
managed tree name; an explicit validated `OWNER/REPO` may override it.
It runs one `gh repo create --private --source <tree> --remote origin --push`.

After success, the connection is atomically updated to GitHub state. Clear
authentication failures produce `GITHUB_AUTH`; clear name collisions produce
`REPOSITORY_EXISTS`; uncertain or partial outcomes produce
`PUBLISH_INCOMPLETE`. Publication does not inspect, adopt, repair, retry, or
delete partial GitHub state. The GitHub operation and local connection update are not
atomic.

## Setup orchestration

`context-tree-setup` is an orchestration skill over the five concrete
workflows. It stops when the project is already connected; otherwise it asks
whether to create a new tree or connect an existing one and delegates to the
chosen workflow. Connect targets include listed managed names when any exist,
plus GitHub `OWNER/REPO` and exact disk paths; without managed trees only
GitHub and disk-path targets are offered. It never publishes without explicit
user confirmation. `context-tree-read` and `context-tree-write` invoke setup
when they receive `NO_CONNECTION`, then retry the operation once.

## Distribution and skills

`install` copies the packaged `skills/` directory into each host's skill
directory: `~/.claude/skills` and `~/.codex/skills`, or the same paths below a
project root with `--project`. A global `npm install` runs it through
`postinstall`, so the skills always ship from the same tarball as the CLI that
installs them and cannot drift from it.

`postinstall` writes only for a global install (`npm_config_global`). Adding the
package as a local dependency prints the `context-tree install` command instead,
so neither a consumer's project install nor this repository's own `pnpm install`
silently modifies a developer's agent configuration. It always exits `0`, so a
failure to place skills never fails an install.

A home install only targets hosts whose configuration directory already exists,
and reports the rest under `skipped`; it never creates a directory for an absent
agent. Installation refuses symlinked or non-directory path segments, writes
skill files with mode `0644`, replaces only `context-tree-*` directories, and
never modifies skills the package does not own.

`create` (including reuse) and `connect` never write the project's `AGENTS.md`.
If it is a regular file and there is no `CLAUDE.md` entry, they best-effort create
`CLAUDE.md` as a relative symlink to `AGENTS.md`. Missing or non-regular
`AGENTS.md` and all existing `CLAUDE.md` entries, including dangling symlinks,
are preserved. Connection storage is independent of these instruction files.
Previously written blocks are left untouched. Tree repository scaffolding
retains its own instructions and symlink.

Skills invoke `context-tree` on `PATH` and do not prescribe raw Git/GitHub
operations. Setup routing happens in the read and write skills. The editorial
policy travels with the skills that need it: the write skill carries the write
gate, source boundary, memory routing, content model, add-vs-edit rules, and
node shape; the read skill carries content classes and drift authority.

The seven-skill inventory is setup, create, connect, read, write, publish, and cleanup;
setup orchestrates the five concrete workflows.
