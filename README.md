# Context Tree

`@first-tree-ai/context-tree` is the complete Context Tree plugin for Codex and
Claude Code, plus a CLI for shell automation. It keeps durable decisions,
constraints, and cross-domain relationships as Markdown in a private GitHub
repository. The plugin bundles four skills, a session-start hook, and its own
private CLI so every part of the plugin stays on the same version. The skills
cover linking, initialization, task-relevant reads, and durable writes.

The core and CLI never manage credentials. One explicit link maps a Git
project's normalized credential-free origin, or a non-Git project's real
directory, to a verified Context Tree checkout. Later sessions resolve that
checkout automatically. GitHub Enterprise Server and other Context Tree forges
are unsupported.

## Install

Context Tree requires Node.js 22.13 or newer and npm. Choose the plugin for the
complete agent experience or the global CLI for direct shell use.

### Plugin — recommended

Install the marketplace and plugin, then start a new session so the host
discovers all four skills and the session-start hook.

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

Repository marketplace installation currently requires access to
`first-tree-ai/context-tree`. The marketplace selectors above resolve the npm
`latest` package, so the advertised flow also requires `latest` to contain the
plugin manifests, hooks, all four skills and launchers, and
`dist/cli/index.mjs`.

Review and trust the session-start hook when the host prompts. Plugin users do
not install the CLI separately: the skills and hook always use the plugin's
private packaged CLI, which is not added to the general shell `PATH`.

Once installed, ask naturally, for example:

> Link this project to my Context Tree, then read the relevant context.

> Publish this architectural decision to the Context Tree.

### CLI — shell automation

Install the same npm package globally when you want to call Context Tree from
scripts or a terminal without the plugin:

```bash
npm install --global @first-tree-ai/context-tree
context-tree --help
```

## CLI

The CLI exposes `link`, `resolve`, `refresh`, `stage`, `init`, `policy`, `read`, `verify`, and
`diff`. Successful command results and runtime or argument failures emit one
versioned JSON object on stdout. Help and version output remain plain text.

```bash
context-tree init \
  --repository acme/context \
  --tree-path ./context-tree
context-tree link --project-path ./service --tree-path ./context-tree
context-tree resolve --project-path ./service
context-tree refresh --project-path ./service
context-tree stage --project-path ./service
context-tree diff ./worktree --base HEAD
context-tree policy
context-tree verify --tree-path ./context-tree
context-tree read --tree-path ./context-tree
context-tree read product --tree-path ./context-tree
```

The `refresh` and `stage` commands own the low-risk Git plumbing that the read
and write skills used to enumerate: discovering the live default branch, checking
it matches the checked-out branch, fast-forwarding (refresh) or fetching an
isolated worktree at the exact commit (stage), and reporting the resulting
commit or base SHA under one versioned contract. `diff` inspects a prepared
worktree's pending changes against a base (default `HEAD`) for a write's
acceptance check. Command errors and runtime failures still emit one versioned
JSON error envelope.

When `--tree-path` is omitted, init writes to `./REPO` and uses the `REPO`
segment verbatim as the tree title. Scaffolding is create-only and always
includes GitHub Actions validation pinned to the package version that created
the tree and filtered to the branch selected by ordinary `git init`. Init
requires Git and respects Git's effective `init.defaultBranch` configuration or
its compiled fallback. The CLI configures only a credential-free GitHub origin
and performs no authenticated GitHub operations. Init records an unambiguous
current project link only in the machine-local links file; it never
embeds that association in the tree. The init skill owns the local commit and
optional publication.

Links are internal state at `~/.context-tree/connections.json`; users do
not edit that file. Git projects resolve by normalized origin. Non-Git projects
resolve from their linked directory and descendants. Resolution validates only the exact checkout,
credential-free matching origin, cleanliness, and root `NODE.md`; it deliberately
does not scan the semantic tree. Read and write skills refresh the live default
branch and run full verification before consuming content. Resolution never
scans for a moved checkout. Use the link skill explicitly to attach an
existing checkout or clone a managed one beneath
`~/.context-tree/checkouts/OWNER/REPO`.

Explicit linking requires a clean exact Git root, a safe GitHub origin, and a
fully valid tree. Init has one narrow exception
for the two newly scaffolded uncommitted files. A relink is idempotent at the
same canonical path. It may replace a different path only when the old checkout
is absent, is no longer an exact checkout, or identifies a different repository,
and the new checkout identifies the stored repository. A dirty old checkout is
still live and cannot be replaced.

Directory reads return that directory's `NODE.md` body and metadata plus
summaries of its immediate children. Leaf reads return the leaf body and no
children. Member classification is semantic metadata, not core access control.
The read skill runs `context-tree refresh --project-path .` to resolve the
linked checkout and fast-forward it to the live default branch, and reports
the exact commit SHA it returns. If GitHub is unavailable, a stale read requires explicit
authorization and is clearly labeled; stale state can never become the base for
a write.

Writes are normal file edits performed by the write skill, not a CLI command.
Every write receives one concrete source through the authorized task context,
runs `context-tree stage --project-path .` to resolve the link and live
default branch, fetch that branch, and create an isolated worktree at its exact
commit. It then edits only necessary Markdown, verifies, inspects the complete
diff, commits, and non-force pushes directly to the
live default branch. Concurrent updates are rebased and verified locally
with bounded retries. If direct publication is denied or the retry limit is
exhausted, the skill rebases against the latest default branch and opens a
conflict-free fallback PR without merging it or requesting reviewers. An
invalid base blocks semantic changes; an explicit repair request may produce a
repair-only write and commit limited to validator findings. Each write and
commit is scoped to one concrete source. Read and write take `agent_slug` from
authoritative role instructions solely to select optional private memory at
`members/<agent_slug>/memory.md`; it is never persisted globally.

The link skill selects or clones a verified checkout and records only the
machine-local mapping. Linking never edits, commits, pushes, or opens a pull
request in the Context Tree repository, and it does not require `agent_slug`.

The package includes all four skills, Codex and Claude Code manifests, and one
shared session-start hook. Compatible hosts inject only the resolved tree
identity and path at session or subagent start. No-match hooks are silent, and
hooks never fetch, clone, or mutate. The hook uses only the CLI packaged with
the plugin and warns when that CLI is unavailable; it never falls back to a
global `PATH` command. Other agents resolve when a skill is selected.

Git commit SHAs identify shared snapshots. Read nodes, child summaries, read results,
verification reports, and policy results intentionally contain no hashes or
digest fields. See [the format specification](docs/specification.md).
