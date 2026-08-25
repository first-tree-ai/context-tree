# Context Tree Format Specification

## Repository and root

A shared Context Tree lives in a `github.com` repository identified as
`OWNER/REPO`. GitHub commit SHAs identify exact shared snapshots. The package
still operates on local clones and worktrees because validation and editing are
filesystem operations.

The tree root is a real directory containing `NODE.md`. Optional `SCOPE.md`
must be a regular UTF-8 file with schema-version-1 frontmatter and non-empty
prose:

```yaml
---
schemaVersion: 1
relatedRepositories:
  - https://github.com/acme/service.git
---
```

`relatedRepositories` remains provider-neutral and accepts at most 64
credential-free HTTP(S), `ssh://`, or scp-style SSH references. It describes
related source repositories; it does not identify the Context Tree repository.

## Nodes and content classes

The root requires `NODE.md`. A semantic directory represented as a node also
contains `NODE.md`; organizational directories containing Markdown leaves need
not. Normal nodes require only a non-empty `title`. Optional
`description` is non-empty prose, and optional `soft_links` contains
tree-root-relative Markdown files or node directories.

- `normal`: root and durable domain decisions.
- `archive-supporting`: evidence beneath `raw-context/`.
- `member`: optional private agent memory beneath `members/`.
- `repo-infra`: dot paths, generated output, instructions, build, and CI files.

Normal content must not depend on archive-supporting content. Symlinks fail
closed: they may not escape the tree, cross content-class boundaries, or stand
in for domain directories. Reads default to normal content. Glob patterns are
case-sensitive and segment-local.

## Memory model

The Context Tree itself is shared memory. Repository-wide memory belongs in the
root `NODE.md`; domain memory belongs in the corresponding domain node or leaf.
There is no reserved shared-memory directory or second store alongside the
canonical domain tree. Add and split shared memory with the ordinary node
policy.

An agent's optional private memory lives at `members/<agent-slug>/memory.md`.
The `members/` directory, agent directory, and memory file are all optional;
there is no member index or required profile. Skills use `agent-slug` only to
select that private path. Scaffolding does not create empty private memory files.

Domain scope controls read relevance, not authorization. Shared tree memory is
commonly readable but writes still require authorization from the user or host
and follow the GitHub workflow. Private memory provides
cooperative isolation only: an agent with access to the entire Git checkout can
access the underlying files, so the format does not claim directory-level
confidentiality.

## Public contracts

CLI JSON uses `schemaVersion: 1`. Version 1 was redefined before deployment;
owner-bearing contracts have no compatibility layer. Exported strict Zod
schemas are the source of truth for library and CLI wire contracts. Unknown
output properties are rejected. Successful command results and runtime or
argument failures emit one JSON object on stdout; help and version output remain
plain text. An invalid `verify` report is still emitted and the command exits
with status 1.

`policy` returns `content` and `schemaVersion`. `read` returns the root, target,
schema version, and selected entries without ownership fields. `verify` returns
the root, schema version, validity, findings, and content-class counts. None
includes a tree digest or per-entry digest. The Git commit SHA is recorded by
the surrounding host Git workflow rather than computed by the core.

## Lifecycle

Scaffolding always creates a validation workflow pinned to the package version
that generated it. New repositories always initialize and publish `main`,
regardless of the user's Git configuration; the generated workflow filters
pushes to `main`. Init takes canonical `OWNER/REPO`, an absent or empty
destination, and a title.

Reads take `agent-slug`, an existing checkout path, and `branch`. Writes take
`agent-slug`, an existing fetch-only checkout path, and the authoritative
`default_branch` publication target.
The exact clean, non-symlink Git root and its credential-free GitHub `origin`
form the authorization boundary. Reads refresh fast-forward-only, validate, and
report the commit SHA; authorized stale reads stay read-only.

Writes fetch the supplied default branch through that checkout and edit an
isolated worktree. One source comes from task context, not an invocation
argument, and scopes one write and commit. The base and result must validate;
publication first uses a non-force direct push to the supplied default branch.
Concurrent updates are rebased, resolved from authorized evidence, and verified
again with bounded retries. Explicit direct-push denial or exhausted retries
uses a latest-base, conflict-free task-branch PR fallback that remains open.
Invalid bases permit only explicitly requested validator-scoped repair, and the
workflow never merges.
