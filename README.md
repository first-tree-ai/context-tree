# Context Tree

`@first-tree-ai/context-tree` provides durable, structured project context for
coding agents. It ships a portable core, CLI, templates, and six
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

```bash
npm install --global @first-tree-ai/context-tree
```

That installs the `context-tree` command and copies the six skills into the
skill directory of every agent you already have:

```text
✓ claude  → ~/.claude/skills/   (6 skills)
✓ codex   → ~/.codex/skills/    (6 skills)
```

Restart your agent so it discovers them, then try asking:

> Set up a Context Tree for this project, then read the relevant context.

> Write this architectural decision to the Context Tree.

Skill installation is a normal command, so you can re-run it after installing a
new agent, or scope it to one project:

```bash
context-tree install                       # every agent you have
context-tree install --host codex          # one agent
context-tree install --project .           # ./.claude/skills and ./.codex/skills
context-tree uninstall                     # remove context-tree-* skills
```

Install and uninstall own exactly the `context-tree-*` skill directories.
Install never touches skills it does not own or creates a configuration directory
for an agent that is not present; uninstall removes every owned-prefix directory
and nothing else. Adding support for another agent is one entry in the host table
in `src/core/install.ts`.

Once a project is connected, `create` and `connect` record the tree in the
project's own `AGENTS.md`, so any agent that reads instruction files knows the
tree exists without host-specific configuration.

## Six skills

### Setup

`context-tree-setup` orchestrates lifecycle setup for projects with no
connection. It asks whether to create a new tree or connect an existing one,
then delegates to the create or connect workflow rather than duplicating
lifecycle policy. Read and write invoke setup when the current project has no
connection. Setup never publishes without explicit confirmation.

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

`context-tree list` reports valid, clean managed trees; `context-tree list --json`
returns them as `{ schemaVersion: 1, trees: [{ name, tree }] }`, and a missing
managed directory is an empty list.

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
`context-tree/write/<name>` branch in the tree. The next `prepare-write` reclaims
one of these only when it holds no commit your checkout lacks, has no pending
change, and has gone untouched for twenty-four hours, so a worktree you are still
editing and a `WRITE_OUTDATED` worktree awaiting its retry are both left alone.
Those keep their pending edits until you clear them with
`git worktree remove <path>` and `git branch -D <branch>` in the connected tree.

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
install  uninstall  create  connect  list  resolve  sync  prepare-write
finish-write  publish  read  verify
```

Setup, create, connect, read, write, and publish ship as six skills; setup
orchestrates the five concrete workflows. `install` is the distribution
entry point, run for you by `npm install`; `uninstall` is its supported reverse.
`resolve`, `sync`, `prepare-write`,
`finish-write`, and `verify` are plumbing or diagnostic commands rather than
separate user intentions; `list` backs setup's connect-target discovery.

### Output

`create`, `connect`, `list`, `resolve`, `publish`, `read`, and `verify` print
human-readable text by default and accept `--json` to emit their strict schema
version `1` payload for scripts and agents; in text mode a failure prints a
sanitized message to stderr with a non-zero exit code. The six skills always
pass `--json`. `sync`, `prepare-write`, `finish-write`, `install`, and `uninstall` are
low-level plumbing and always emit that JSON (with the error envelope on stdout).
`--help` and `--version` are always plain text.

```bash
context-tree verify                 # human-readable report
context-tree verify --json          # { "ok": true, "schemaVersion": 1, ... }
```

`verify` is intended for CI and diagnostics. Normal skills invoke it only after
an operation reports invalid tree content.

## Development

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm check:package
```

See [docs/specification.md](docs/specification.md) for contracts and safety
invariants.
