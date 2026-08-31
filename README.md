# Context Tree

`@first-tree-ai/context-tree` gives agents durable project context: decisions,
constraints, and relationships stored as Markdown in a private GitHub
repository. It supports Codex and Claude Code through a portable Agent Plugins
v1 package and includes a CLI for shell automation.

Each project is explicitly linked to a verified local checkout. Future sessions
resolve that checkout from the project's credential-free Git origin, or from its
real directory when the project is not a Git repository. Context Tree currently
supports repositories on GitHub.com only; GitHub Enterprise Server and other
forges are not supported.

## Install

Node.js 22.13 or newer and npm are required. Git is also required to initialize
trees and use Git-backed workflows.

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

Marketplace installation requires repository access to
`first-tree-ai/context-tree`. These selectors resolve the npm `latest` package,
which must contain the plugin manifests, hook, five skills and launchers, and
`dist/cli/index.mjs`. Review and trust the session-start hook if your host asks.

The plugin uses its own packaged CLI, so plugin users do not need a global CLI
installation. Try asking:

> Link this project to my Context Tree, then read the relevant context.

> Publish this architectural decision to the Context Tree.

### Global CLI (optional)

Install the package globally only when scripts or terminal workflows need a
`context-tree` command on `PATH`:

```bash
npm install --global @first-tree-ai/context-tree
context-tree --help
```

## CLI workflows

### Initialize or link a tree

Create a new local tree and record a local link for the current project:

```bash
context-tree init context --tree-path ./context-tree
```

Or link a project to an existing, verified checkout:

```bash
context-tree link --project-path ./service --tree-path ./context-tree
```

If `init` omits `--tree-path`, it creates `./name`, using the tree name verbatim
as the directory and title. Scaffolding is local-only and create-only: it runs
ordinary `git init`, commits the four scaffold files on Git's effective default
branch, creates a validation workflow pinned to the package version, and never
configures a Git remote or contacts GitHub.

### Publish a local tree

Link a local tree to GitHub when you are ready; until then every link, read,
write, and verify command works with plain Git alone:

```bash
context-tree push acme/context --tree-path ./context-tree
```

`push` with an `owner/repo` creates a new **private** GitHub repository through
the GitHub CLI, configures the credential-free origin, pushes the current
branch, and sets it as the default branch. `push` without an argument pushes
committed state through an existing origin. It only ever publishes commits:
uncommitted changes are ignored and reported as `uncommittedFiles` in the
result. A recorded link picks up the repository identity automatically on the
next `resolve`; relinking is unnecessary.

### Resolve, refresh, read, and verify

```bash
context-tree resolve --project-path ./service
context-tree refresh --project-path ./service
context-tree read --tree-path ./context-tree
context-tree read product --tree-path ./context-tree
context-tree verify --tree-path ./context-tree
```

`resolve` checks the recorded checkout, origin, cleanliness, and root
`NODE.md`; it does not scan the whole semantic tree. `refresh` discovers the
live default branch, requires it to match the checked-out branch, and
fast-forwards before reads. Agent reads refresh and fully verify the tree, then
report the exact commit SHA. If GitHub is unavailable, a stale read requires
explicit authorization, is clearly labeled, and can never be used as a write
base.

Directory reads return the selected `NODE.md` body and metadata plus summaries
of immediate children. Leaf reads return the leaf body without children.

### Prepare and inspect a write

```bash
context-tree stage --project-path ./service
context-tree diff ./prepared-worktree --base HEAD
```

For a published tree, `stage` fetches the live default branch and creates an
isolated worktree at its exact commit; a local-only tree stages from its own
`HEAD`. After edits, `diff` reports all pending changes against the given base
(`HEAD` by default). These are preparation and inspection commands. The write
skill edits, verifies, reviews, commits, and publishes: directly to the default
branch for published trees, or by fast-forwarding the local checkout for
local-only trees.

### Retrieve the policy

```bash
context-tree policy
```

This returns the canonical policy packaged with the installed version.

## Command reference

| Command | Purpose | Essential arguments and options |
| --- | --- | --- |
| `link` | Link a project to a verified checkout | `--project-path <path>`, `--tree-path <path>` |
| `resolve` | Resolve a project's recorded link | `--project-path <path>` (default `.`) |
| `refresh` | Fast-forward a linked tree to its live default branch | `--project-path <path>` (default `.`); errors `NO_REMOTE` for local-only trees |
| `stage` | Prepare an isolated worktree for a write | `--project-path <path>` (default `.`) |
| `diff` | Inspect changes in a prepared worktree | `[tree-path]` (default `.`), `--base <ref>` (default `HEAD`) |
| `init` | Scaffold a new local tree with an initial commit | `<name>`, optional `--tree-path <path>` (default `./name`) |
| `policy` | Print the packaged Context Tree policy | None |
| `read` | Read a node or Markdown leaf | `[path]` (default `.`), `--tree-path <path>` (default `.`) |
| `push` | Create a private GitHub repository when needed and push committed state | `[owner/repo]`, `--tree-path <path>` (default `.`) |
| `verify` | Validate tree structure and safety | `--tree-path <path>` (default `.`) |

Successful commands and runtime or argument failures emit one
`schemaVersion: 1` JSON object on stdout. Help and version output are plain
text. An invalid `verify` report is still emitted and exits with status 1. The
strict Zod schemas are the source of truth for public wire contracts.

Links are machine-local internal state in
`~/.context-tree/connections.json`; do not edit this file manually. Managed
clones default to `~/.context-tree/checkouts/OWNER/REPO`. Resolution does not
search for moved checkouts, so use the link skill again to repair a stale link.

## Safety and lifecycle

- **Credentials:** The core and CLI neither manage credentials nor perform
  authenticated GitHub operations. Repository URLs containing credentials are
  rejected and never logged; host Git and GitHub CLI own authentication.
- **Checkout validation:** Linking requires a clean, exact Git root and a fully
  valid tree; a tree may be local-only or published with a safe GitHub origin.
  Resolution fails closed for symlinks, moved paths, dirty trees, repository
  mismatches, and invalid roots.
- **Git operations:** Reads fast-forward only. Writes start from a freshly
  fetched default-branch commit (or local `HEAD` for unpublished trees) in an
  isolated worktree and never force-push. Commit SHAs identify shared snapshots.
  `push` publishes committed state only, always creates private repositories,
  and never commits uncommitted work.
- **Hooks:** Session and subagent hooks inject only a resolved tree identity and
  path. They are silent when no link matches and never fetch, clone, or mutate.
  They use only the plugin's packaged CLI and warn if it is unavailable.
- **Write fallback:** For published trees, the write skill retries bounded
  concurrent updates. If a direct push is denied or retries are exhausted, it
  opens a conflict-free PR from the latest default branch without merging it or
  requesting reviewers. Each write and commit is scoped to one concrete source.

For tree structure, link replacement rules, validation boundaries, memory
selection, read/write lifecycle details, and exact public contracts, see the
[Context Tree format specification](docs/specification.md).

## Compatibility

The package uses `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` as
host adapters for installation and lifecycle integration. It intentionally
omits a root `plugin.json`: Codex 0.151.0 treats that portable manifest as an
alternate plugin shape and fails to discover bundled lifecycle hooks. Both
marketplaces install the same npm package, and all plugin components use its
private packaged CLI at the same version rather than a global `PATH` command.
