# Context Tree lifecycle specification

## Scope

The package exposes setup as an orchestration skill over five concrete user
intentions: create, connect, read, write, and publish. A separate cleanup skill
performs editorial maintenance through the same write lifecycle.
`install` is the distribution entry point. Supporting commands (`resolve`, `sync`, `list`,
`prepare-write`, `finish-write`, and `verify`) are integration plumbing. Every
JSON contract is strict. Connection storage, `connect`, `resolve`, `sync`,
`prepare-write`, and cleanup schedule/status contracts use `schemaVersion: 2`.
Unchanged command responses (including cleanup run/logs and error envelopes)
and tree document frontmatter remain version 1. Unsupported stored formats are rejected without migration or deletion.

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
- Duplicate aliases or tree identities within one project produce `CORRUPT_CONNECTION`.
- Connections are equal; order provides no authority. Each project may attach several trees.
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

type Connection = { alias: string; projectPath: string; tree: Tree };
type Connect = { alias: string; tree: Tree; schemaVersion: 2 };
type Discovery = Connection & ({ ok: true } | { ok: false; error: { code: string; message: string } });
type Resolve = { connections: Discovery[]; schemaVersion: 2 };
type ManagedTreeListing = {
  schemaVersion: 1;
  trees: Array<{ name: string; tree: Tree }>;
};
type SyncEntry = { alias: string; tree: Tree } & (
  { ok: true; branch: string; sha: string; schemaVersion: 2 } |
  { ok: false; error: { code: string; message: string } }
);
type Sync = { connections: SyncEntry[]; schemaVersion: 2 };
type Prepare = { connection: Connection; worktreePath: string; schemaVersion: 2 };
type Finish = { branch: string; sha: string; schemaVersion: 1 };
type Publish = {
  repository: string; url: string; branch: string; sha: string;
  schemaVersion: 1;
};
type Disconnect = { disconnected: boolean; schemaVersion: 1 };
```

Errors use `{ ok: false, error: { code, message }, schemaVersion: 1 }`.
Lifecycle-specific codes are `AMBIGUOUS_CONNECTION`, `NO_CONNECTION`, `CORRUPT_CONNECTION`,
`STALE_CONNECTION`, `DIRTY_TREE`, `INVALID_TREE`, `WRITE_OUTDATED`,
`GITHUB_AUTH`, `GITHUB_PERMISSION`, `REPOSITORY_EXISTS`, and
`PUBLISH_INCOMPLETE`. Other failures use `CONTEXT_TREE_FAILED`.

## Creation and connection

`create` derives `<normalized-project-directory>-context-tree` from the
canonical project root. It scaffolds and commits the tree in the flat managed
namespace before atomically connecting it. Repetition is idempotent only when
the project is still connected to that tree. An occupied name otherwise fails
with guidance to use `connect <name>`. `--name <name> --as <alias>` creates an
additional tree; omitted names retain the project-derived default. Files created by a
failed create are removed; a destination that existed before the invocation is
never removed.

`connect <name>` performs an exact managed-directory lookup. `connect
OWNER/REPO` reuses a checkout whose verified origin matches the full repository
identity or clones it into a managed name derived from `OWNER/REPO`, so equal
repository names under different owners never share a directory. Every
selection is validated and safely classified as local or GitHub state.
Repository and unsafe-origin name collisions fail before the project
connection changes. Connections are additive. `--as <alias>` sets a project-local
name, defaulting to the managed name, repository name, or checkout basename.
An alias cannot point at a different tree; one tree cannot have multiple aliases
within a project. Reconnecting the same tree and alias is idempotent. Only a
directory created by a failed clone is removed. Authentication and permission
failures during the clone report `GITHUB_AUTH` and `GITHUB_PERMISSION`.

`disconnect --tree <alias>` removes one attachment; `--all` removes all.
The selector is optional with one connection and required with several.
Disconnection preserves the trees and repositories and works for broken trees.

`connect --tree-path <path>` attaches an exact, clean, fully valid Git root
with no symlink components in place and never copies, moves, or deletes it.
Trees without an origin classify as local state; credential-free GitHub
origins classify as GitHub state; all other origins are rejected. Stored-
connection validation accepts verified external paths while name-based
discovery remains restricted to the managed namespace. `list` reports valid,
clean managed trees as `{ schemaVersion: 1, trees: [{ name, tree }] }`; a
missing managed directory is an empty list and is never created by listing.

## Synchronization and reading

`resolve` returns an alias-sorted collection of healthy or broken connections.
`sync` processes all connections and retains individual sanitized failures alongside
successful branch/SHA results; any failure sets a nonzero exit status. Both accept
`--tree <alias>` to filter. The read skill reads every successful root index and
follows task-relevant branches, attributing context to tree and revision. Conflicts
are surfaced and resolved from evidence or clarification, never connection order.

Local synchronization makes no network call and reports the checked-out branch
and exact `HEAD`. GitHub synchronization performs exactly one
`git pull --ff-only origin <checked-out-branch>`, revalidates, then reports its
exact SHA. It does not discover or enforce the remote default branch and does
not report an `updated` flag.

`read` returns a selected node and only its immediate indexed children. Ordinary
readers navigate narrowly from indexes; cleanup recursively visits all normal
and member children.

## Writing

`prepare-write` synchronizes and creates a random `context-tree/write/*` branch
in an isolated worktree at the synchronized SHA. With several connections,
`--tree <alias>` is required. It returns the selected connection, worktree path,
and schema version. Connection metadata is persisted in the worktree Git directory.

`finish-write` requires that the supplied path is a real non-symlink directory,
matches its saved project and connection, belongs to that tree's Git common directory, uses the reserved branch
prefix, contains pending changes, and verifies as a complete Context Tree.
Removed or replaced connections fail before committing and preserve the worktree.
Destination selection alone grants no write authorization. It stages everything and creates one
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
its preserved edits. Reclamation is silent and limited to the selected repository.
Writes spanning trees require separate operations and outcomes, with no cross-tree transaction.

The write skill may prepare fresh and reapply the intended semantic change
once after `WRITE_OUTDATED`, after rereading affected nodes and their placement
in the fresh worktree. It adapts to moved or consolidated content rather than
replaying a rejected patch. A second outdated result is reported to the user.

## Cleanup

`context-tree-cleanup` resolves a stable absolute project path, prepares a fresh
worktree, and completes recursive `read --json` inspection of all shared and
member content before editing, including other agents' directories. Repository
infrastructure is excluded from editorial inspection and edits. Cleanup preserves
useful member working memory, active work, personal context, audience, and
ownership; it does not turn personal preferences into shared policy. It removes noise,
consolidates duplicates without losing unique rationale or qualifications, and
moves misplaced content to the narrowest suitable existing domain. It updates
indexes and incoming and outgoing links, retaining the original location if
infrastructure would need edits. It avoids cosmetic changes, invented
choices, new top-level domains, and structure without retrieval benefit.
Uncertain claims survive; contradictions are reported without source-repository
investigation.

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

The CLI provides cleanup schedule, status, remove, run, and logs commands with
`--tree <alias>` selection. A project may schedule multiple trees; each tree
identity has one schedule shared across projects. A versioned schedule persists
the alias, project, tree state, and identity. Removed or replaced connections make
it inactive. Activity and logs belong to the relevant tree, and successful commands
refresh only the trees they used. Connect, sync, prepare-write, and finish-write
match activity by tree identity across checkouts; partial sync refreshes only
successful entries. Create and read match by path. Without `--tree`, cleanup
selects the sole connection before considering retained schedules; multiple
connections require selection. Explicit aliases can access retained schedules,
and saved-schedule lookup remains available when no connections remain.
Native LaunchAgents or systemd user timers run
the saved configuration; host application UI is outside this repository's scope.

## Publication

`publish` requires stored local state, a clean valid tree, and no existing
`origin`. By default it combines the authenticated GitHub login with the
managed tree name; an explicit validated `OWNER/REPO` may override it.
It runs one `gh repo create --private --source <tree> --remote origin --push`.

With several connections, `publish --tree <alias>` selects the local destination.
After success, all connection records referencing that checkout are atomically
updated to GitHub state, preserving aliases and unrelated connections. Clear
authentication failures produce `GITHUB_AUTH`; clear permission denials produce
`GITHUB_PERMISSION`; clear name collisions produce `REPOSITORY_EXISTS`;
uncertain or partial outcomes produce `PUBLISH_INCOMPLETE`. Publication does not inspect, adopt, repair, retry, or
delete partial GitHub state. The GitHub operation and local connection update are not
atomic.

## Setup orchestration

`context-tree-setup` runs when requested or when an ordinary read/write returns
`NO_CONNECTION`. It retains the original stable project path. Successful resolve
returns ready without replacing the existing connection. Otherwise it reuses
prior user choices or offers an existing tree, a new local tree, a new private
GitHub tree, or skipping for the session. Existing targets include listed
managed names with local/GitHub kind, GitHub `OWNER/REPO`, and exact checkout
paths. An explicit request to add a tree continues setup even with existing connections.

Create defaults to local-only and does not prompt for publication afterward.
Choosing a new private GitHub tree authorizes create followed by publish; it
does not require repeated approval. A publication failure reports the remaining
local connection and any uncertain remote state, and does not count as completed
GitHub setup. Other errors also stop setup without repair or fallback.

Setup returns a prose ready, skipped, or failed outcome; public wire contracts
are unchanged. Read/write resume their pending operation once only after ready.
A writer reads the connected tree's relevant nodes and placement before
finalizing a delegated brief. A skipped, deferred, or failed setup does not
retry the operation or claim context was read or saved. The original user task
continues where possible. A session opt-out suppresses further read/write and
setup attempts for that project until the user reopens them; it lives only in
conversation context and does not alter files or stored connections. Cleanup
remains a separately authorized workflow and does not invoke setup.

## Distribution and skills

`install` copies the packaged `skills/` directory into each host's skill
directory: `~/.claude/skills`, and `~/.agents/skills` for Codex and Pi, or the same
paths below a project root with `--project`. A global `npm install` runs it
through `postinstall`, so the skills always ship from the same tarball as the CLI
that installs them and cannot drift from it.

`postinstall` writes only for a global install (`npm_config_global`). Adding the
package as a local dependency prints the `context-tree install` command instead,
so neither a consumer's project install nor this repository's own `pnpm install`
silently modifies a developer's agent configuration. It always exits `0`, so a
failure to place skills never fails an install.

A home install only targets hosts whose configuration directory already exists,
and reports the rest under `skipped`; it never creates a directory for an absent
agent. Codex detection uses `CODEX_HOME` when set, otherwise `~/.codex`; its skills
destination remains `~/.agents/skills` in either case. Installation refuses symlinked or non-directory path segments, writes
skill files with mode `0644`, replaces only `context-tree-*` directories, and
never modifies skills the package does not own. Codex and Pi share
`.agents/skills`, so that directory is written once and reported for each host;
no host ever installs to `.codex/skills`.

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

The eight-skill inventory is setup, create, connect, read, write, publish, cleanup,
and schedule-cleanup;
setup orchestrates the five concrete workflows.
