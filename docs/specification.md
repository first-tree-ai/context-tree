# Context Tree Format Specification

## Repository and root

A Context Tree is a Git repository of Markdown context. It can live entirely
locally, or it can be published to a `github.com` repository identified as
`OWNER/REPO`; publication is a later, explicit `push` step, and GitHub commit
SHAs identify exact shared snapshots of published trees. The package still
operates on local clones and worktrees because validation and editing are
filesystem operations.

The tree root is a real directory containing a regular, non-symlink `NODE.md`.
That root node is both the tree manifest and the repository-wide context node.
It must contain non-empty prose and schema-version-1 frontmatter:

```yaml
---
schemaVersion: 1
title: "Service Context"
description: "Durable decisions shared across service domains."
---
```

Root-only `schemaVersion` is required and is not valid on domain nodes or
Markdown leaves. A legacy `SCOPE.md` has no special meaning and is validated as
an ordinary leaf.

## Nodes and content classes

The root requires the manifest fields above in `NODE.md`. Every semantic
directory contains `NODE.md`, including `members/` and each member directory.
Nodes and leaves require a non-empty `title`. Optional
`description` is non-empty prose, and optional `soft_links` contains
tree-root-relative Markdown files or node directories.

- `normal`: root and durable domain decisions.
- `member`: member-oriented context beneath `members/`.
- `repo-infra`: dot paths, generated output, root `scripts/`, instructions, build, and CI files.

`raw-context/` has no reserved meaning and follows ordinary node rules.
Symlinks fail closed: they may not escape the tree, cross content-class
boundaries, or stand in for domain directories. Repository infrastructure is
excluded from semantic validation and reads.

## Memory model

The Context Tree itself is shared memory. Repository-wide memory belongs in the
root `NODE.md`; domain memory belongs in the corresponding domain node or leaf.
There is no reserved shared-memory directory or second store alongside the
canonical domain tree. Add and split shared memory with the ordinary node
policy.

An agent's optional private memory lives at `members/<agent_slug>/memory.md`.
The `members/` directory, agent directory, and memory file are all optional;
when present, each directory requires its ordinary `NODE.md` index. Skills use
`agent_slug` to avoid unrelated member content by default. Scaffolding does not
create empty private memory files.

Domain scope controls read relevance, not authorization. Shared tree memory is
commonly readable but writes still require authorization from the user or host
and follow the GitHub workflow. Member boundaries are relevance guidance only:
the library and CLI apply no member-level access restriction, and the format
claims no directory-level confidentiality.

## Public contracts

CLI JSON uses `schemaVersion: 1`. Version 1 was redefined before deployment;
owner-bearing contracts have no compatibility layer. Exported strict Zod
schemas are the source of truth for library and CLI wire contracts. Unknown
output properties are rejected. Successful command results and runtime or
argument failures emit one JSON object on stdout; help and version output remain
plain text. An invalid `verify` report is still emitted and the command exits
with status 1.

`policy` returns `content` and `schemaVersion`. `read` returns the root, target,
schema version, a selected node with its complete parsed frontmatter and body,
and sorted immediate child summaries. `verify` returns
the root, schema version, validity, findings, and content-class counts. None
includes a tree digest or per-entry digest. The Git commit SHA is recorded by
the surrounding host Git workflow rather than computed by the core.

`link` and `resolve` return a strict link result containing the
project identity, an optional tree `OWNER/REPO`, and a canonical absolute,
single-line checkout path. Link and lifecycle failures distinguish `NO_LINK`,
`AMBIGUOUS_LINK`, `CORRUPT_LINK`, `STALE_LINK`, `NO_REMOTE`, and `NO_COMMITS`
from other CLI failures. `push` returns the branch, commit SHA, remote default
branch, remote identity and URL, and uncommitted-file count.

## Lifecycle

Scaffolding creates exactly four files: root `NODE.md`, root `AGENTS.md`, root
`CLAUDE.md`, and `.github/workflows/validate-context-tree.yml`. `AGENTS.md`
explains the tree's purpose, structure, authority, and write discipline to
agents entering the repository. `CLAUDE.md` is a relative symlink to `AGENTS.md`
so both instruction filenames expose the same packaged guidance. The workflow
is pinned to the package version that generated it. Init takes a local tree
`name` and an optional absent or empty destination. It requires Git, runs
ordinary `git init`, and uses the unborn branch selected by Git's effective
`init.defaultBranch` configuration or compiled fallback. The generated workflow
filters pushes to that exact branch. The local tree title and default
destination name come from `name`. Init never configures a Git remote and never
contacts GitHub. Init commits exactly the four scaffold files, records an
unambiguous current project link only in the machine-local links file, and
never embeds the source-project association in the tree. The tree is usable
locally with plain Git before any GitHub repository exists.

`push [OWNER/REPO]` publishes committed state. With `OWNER/REPO`, the CLI
requires a verified tree and at least one commit, creates a new **private**
GitHub repository through the GitHub CLI, configures the credential-free
`https://github.com/OWNER/REPO.git` origin, pushes the current branch with its
upstream, and sets and reports the remote default branch. Without the argument,
it pushes through an existing origin. `push` never stages or commits uncommitted
work, which it reports as `uncommittedFiles`. The GitHub CLI owns
authentication; a repository that already exists is a hard error.

Internal links live at `~/.context-tree/connections.json`. A link
maps a normalized Git project origin or a real non-Git directory to an optional
canonical tree `OWNER/REPO` plus a canonical absolute, single-line checkout
path; the repository identity is absent until the tree is published. Git lookup
also confirms that the project origin matches the local record; non-Git lookup
includes descendants. Zero or multiple matches fail, and a project cannot link
to a different tree repository. Explicit linking requires a clean exact Git
root, a safe GitHub origin when one is configured, and complete tree
verification. Init automatically links its new committed scaffold. Resolve
rejects symlinked, dirty, moved, repository-mismatched, and invalid-root
candidates, but parses only root `NODE.md` rather than scanning all semantic
content. Full verification is the responsibility of read and write after
refresh. When a stored link has no repository identity and the checkout has
gained a GitHub origin, resolve backfills the stored identity atomically; after
a later `push`, relinking is unnecessary.

A moved checkout produces `STALE_LINK`; explicit linking may replace its
path only after verifying the same stored tree repository and proving the prior
path absent, no longer an exact checkout, or occupied by another repository. A
second live checkout cannot replace the stored path, even when the stored
checkout is dirty. Relinking the same canonical path is idempotent.

Link setup selects or clones a verified checkout and writes only the local link
record. It never mutates or publishes the Context Tree repository.

Reads and writes take only `agent_slug`, sourced from authoritative task role
instructions. They resolve the current project, then discover the live default
branch using `git ls-remote --symref origin HEAD`; branches are never configured
or cached. For local-only trees without an origin, `refresh` fails with
`NO_REMOTE` and `stage` bases the worktree on local `HEAD`. The exact clean,
non-symlink Git root remains the authorization boundary, with the
credential-free GitHub `origin` matching the link record when one is configured.
Resolution selects a candidate and does not replace full semantic verification.
Reads refresh fast-forward-only, validate, and report the commit SHA; authorized
stale reads stay read-only.

The package root exports `linkProject`, `resolveLink`, `pushTree`,
`readContextTreePolicy`, `readTree`, `scaffoldTree`, and `verifyTree`.
Project identification, URL normalization, and the links-file storage
schema are internal. Public strict CLI result schemas remain available from
the schemas entrypoint.

Writes fetch the discovered default branch through that checkout (or use local
`HEAD` for local-only trees) and edit an isolated worktree. One source comes
from task context, not an invocation argument, and scopes one write and commit.
The base and result must validate. Published trees publish with a non-force
direct push to the discovered default branch, rebase concurrent updates with
bounded retries, and fall back to a latest-base, conflict-free task-branch PR
that remains open on explicit denial or exhausted retries. Local-only trees
publish by fast-forwarding the main checkout to the verified task commit and
have no PR fallback. Invalid bases permit only explicitly requested
validator-scoped repair, and the workflow never merges.
