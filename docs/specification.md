# Context Tree Format Specification

## Repository and root

A shared Context Tree lives in a `github.com` repository identified as
`OWNER/REPO`. GitHub commit SHAs identify exact shared snapshots. The package
still operates on local clones and worktrees because validation and editing are
filesystem operations.

The tree root is a real directory containing a regular, non-symlink `NODE.md`.
That root node is both the tree manifest and the repository-wide context node.
It must contain non-empty prose and schema-version-1 frontmatter:

```yaml
---
schemaVersion: 1
title: "Service Context"
description: "Durable decisions shared across service domains."
relatedRepositories:
  - https://github.com/acme/service.git
---
```

Root-only `schemaVersion` is required. Root-only `relatedRepositories` is
optional, remains provider-neutral, and accepts at most 64
credential-free HTTP(S), `ssh://`, or scp-style SSH references. It describes
related source repositories; it does not identify the Context Tree repository.
Neither root-only field is valid on domain nodes or Markdown leaves. A legacy
`SCOPE.md` has no special meaning and is validated as an ordinary leaf.

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

## Lifecycle

Scaffolding creates exactly two files: root `NODE.md` and
`.github/workflows/validate-context-tree.yml`. The workflow is pinned to the
package version that generated it. Init takes canonical `OWNER/REPO` and an
optional absent or empty destination. It requires Git, runs ordinary `git init`, and uses the
unborn branch selected by Git's effective `init.defaultBranch` configuration or
compiled fallback. The generated workflow filters pushes to that exact branch.
The local tree title and default destination name come from `REPO`. The core and
CLI perform no GitHub or credential operations.

Reads take `agent_slug`, an existing checkout path, and `branch`. Writes take
`agent_slug`, an existing fetch-only checkout path, and the authoritative
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
