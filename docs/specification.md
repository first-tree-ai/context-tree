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
not. Normal nodes require a non-empty `title` and `owners` array. Optional
`description` is non-empty prose, and optional `soft_links` contains
tree-root-relative Markdown files or node directories.

- `normal`: root and durable domain decisions.
- `archive-supporting`: evidence beneath `raw-context/`.
- `member`: ownership and routing beneath `members/`.
- `repo-infra`: dot paths, generated output, instructions, build, and CI files.

Normal content must not depend on archive-supporting content. Symlinks fail
closed: they may not escape the tree, cross content-class boundaries, or stand
in for domain directories. Reads default to normal content. Glob patterns are
case-sensitive and segment-local.

`members/NODE.md` is the member index. Every direct member directory requires a
`NODE.md` with title, owners, type (`human` or `agent`), role, and domains.

## Memory conventions

Memory uses ordinary Markdown and existing frontmatter. Shared global memory
lives at `memory/NODE.md`, shared domain memory at `memory/<domain>.md`, and an
agent's private memory at `members/<agent-id>/memory.md` beside its normal
member profile. All memory files are optional. Scaffolding does not create
empty memory files or speculative domain scopes.

The host or runtime supplies the trusted agent identity; the Context Tree does
not authenticate an identity found in task prose. Domain scope controls read
relevance, not authorization. Shared memory is commonly readable but remains
owner-written. Private memory provides cooperative isolation only: an agent
with access to the entire Git checkout can access the underlying files, so the
format does not claim directory-level confidentiality. One Markdown file per
scope is sufficient until the ordinary node-splitting policy justifies more.

## Public contracts

CLI JSON uses `schemaVersion: 1`. Exported strict Zod schemas are the source of
truth for library and CLI wire contracts. Unknown output properties are
rejected. Successful command results and runtime or argument failures emit one
JSON object on stdout; help and version output remain plain text. An invalid
`verify` report is still emitted and the command exits with status 1.

`policy` returns `content` and `schemaVersion`. `read` returns the root, target,
schema version, and selected entries. `verify` returns the root, schema version,
validity, findings, and content-class counts. None includes a tree digest or
per-entry digest. The Git commit SHA is recorded by the surrounding host Git
workflow rather than computed by the core.

## Lifecycle

Scaffolding always creates a validation workflow pinned to the package version
that generated it. New repositories always initialize and publish `main`,
regardless of the user's Git configuration; the generated workflow filters
pushes to `main`. Hosted reads require an explicit `OWNER/REPO` and branch, a
clean matching checkout, fast-forward refresh, validation, and a reported
commit SHA. Explicitly authorized stale reads are labeled and remain read-only.

Every write starts in an isolated worktree at a freshly fetched base commit.
The base and final tree must validate; all edits are direct, necessary Markdown
changes; the full diff is reviewed; publication uses a non-force task-branch
push and GitHub PR. An invalid base permits only an explicitly requested,
validator-scoped repair PR. No workflow merges automatically.
