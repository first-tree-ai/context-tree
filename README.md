# Context Tree

`@first-tree-ai/context-tree` provides durable, structured project context for
coding agents. It ships a portable core, CLI, policy, templates, hook, and six
framework-neutral skills.

A Context Tree records current decisions, constraints, relationships, and their
rationale. Source repositories still own implementation detail, task history,
and credentials.

## Requirements

- Node.js 22.13 or newer
- Git
- GitHub CLI (`gh`) only for connecting a GitHub tree or publishing

Git and GitHub authentication remain owned by the host tools. Repository inputs
are credential-free `OWNER/REPO` identities, never URLs containing credentials.

## Install

### Codex or Claude Code plugin (recommended)

Install the marketplace and plugin, then start a new session so the host can
discover the skills and lifecycle hook.

For Codex:

```bash
codex plugin marketplace add first-tree-ai/context-tree
codex plugin add context-tree@context-tree
```

For Claude Code:

```bash
claude plugin marketplace add first-tree-ai/context-tree
claude plugin install context-tree@context-tree
```

Both marketplaces install the same npm package, and every plugin component uses
its private packaged CLI rather than a global `PATH` command — so plugin users
need no separate CLI installation. Review and trust the session-start hook if
your host asks. Then try asking:

> Set up a Context Tree for this project, then read the relevant context.

> Write this architectural decision to the Context Tree.

### Global CLI (optional)

Install globally only when scripts or terminal workflows need a `context-tree`
command on `PATH`:

```bash
npm install --global @first-tree-ai/context-tree
context-tree --help
```

## Six skills

### Setup

`context-tree-setup` orchestrates lifecycle setup for projects with no
connection. It asks whether to create a new tree or connect an existing one,
then delegates to the create or connect workflow rather than duplicating
lifecycle policy. Read and write invoke setup when the current project has no
connection, and the session hook remains silent. Setup never publishes without
explicit confirmation.

### Create

```bash
context-tree create --project-path ./service
```

`create` derives `<normalized-project-directory>-context-tree`, scaffolds and
commits it under `~/.context-tree/trees`, then connects it atomically. It is
idempotent only while the project remains connected to that managed tree.

### Connect

Connect to an existing managed tree by exact name:

```bash
context-tree connect shared-context-tree --project-path ./service
```

Or reuse or clone a GitHub tree by repository identity:

```bash
context-tree connect OWNER/REPO --project-path ./service
```

Or connect an existing checkout in place by exact disk path:

```bash
context-tree connect --tree-path /path/to/a/tree --project-path ./service
```

`connect --tree-path` requires an exact, clean, fully valid Git root with no
symlink components. Trees without an origin connect as local state;
credential-free GitHub origins connect as GitHub state. External disk trees
are never copied, moved, or deleted.

An identical connection is idempotent. An explicit connect automatically
switches the project. GitHub checkouts use the repository's lowercase name in
the same flat managed namespace as created trees.

`context-tree list` reports valid, clean managed trees as
`{ schemaVersion: 1, trees: [{ name, tree }] }`; a missing managed directory
is an empty list.

### Read

```bash
context-tree sync --project-path ./service
context-tree read product/runtime.md --tree-path /path/from/sync
```

Local trees report their checked-out branch and exact `HEAD` without network
access. GitHub trees perform one fast-forward-only pull of the checked-out
branch. Reads navigate from indexes to narrow, task-relevant children.

### Write

```bash
context-tree prepare-write --project-path ./service
# Edit only the returned worktreePath.
context-tree finish-write --project-path ./service \
  --worktree-path /path/from/prepare \
  --message "Record runtime constraint"
```

Preparation synchronizes first and creates a random isolated worktree at that
exact commit. Finishing validates the worktree, stages every pending change,
creates one unsigned commit using the host identity, and attempts one
fast-forward merge for local trees or one non-force push for GitHub trees.

If the destination advanced, `finish-write` returns `WRITE_OUTDATED` and
preserves the worktree. Prepare again and reapply the intended semantic change
once; there is no automatic rebase, retry loop, or pull-request fallback.

A preserved or abandoned write leaves its temporary worktree on disk and a
`context-tree/write/<name>` branch in the tree. Nothing removes these for you:
clear them with `git worktree remove <path>` and `git branch -D <branch>` in the
connected tree once you no longer need the pending edits.

### Publish

```bash
context-tree publish --project-path ./service
# or: context-tree publish OWNER/REPO --project-path ./service
```

Publishing requires a clean, valid local tree with no `origin`. It creates one
new private GitHub repository, pushes the checkout, and then changes the stored
connection to GitHub state. Those external and local changes are not atomic;
uncertain or partial outcomes are reported as `PUBLISH_INCOMPLETE` and are not
automatically inspected or repaired.

## Project identity

Git project paths resolve to the exact root of that checkout. A clone or Git
worktree is independent even if it shares an origin or Git common directory.
Non-Git projects match only the exact connected directory; nested directories
do not inherit the connection.

Connection data is written atomically with mode `0600` at
`~/.context-tree/connections.json`. Duplicate project records are corruption.
Stored local/GitHub state is not reclassified from mutable remotes.

Every command that touches a connected tree reports why it refused:
`NO_CONNECTION` (nothing connected), `DIRTY_TREE` (your uncommitted edits —
commit or discard them), `INVALID_TREE` (structure fails `verify`),
`STALE_CONNECTION` (the stored path is gone; connect again), and
`CORRUPT_CONNECTION` (unreadable or duplicated records).

## CLI plumbing

The public command inventory is:

```text
create  connect  list  resolve  sync  prepare-write  finish-write
publish  read  verify  policy
```

Setup, create, connect, read, write, and publish ship as six skills; setup
orchestrates the five concrete workflows. `resolve`, `sync`, `prepare-write`,
`finish-write`, `verify`, and `policy` are plugin plumbing or diagnostic
commands rather than separate user intentions; `list` backs setup's
connect-target discovery.
All machine-readable responses use strict schema version `1`.

`verify` is intended for CI and diagnostics. Normal skills invoke it only after
an operation reports invalid tree content.

## Development

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm validate:skills
pnpm check:package
npm pack --dry-run
```

See [docs/specification.md](docs/specification.md) for contracts and safety
invariants.
