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
which must contain the plugin manifests, hook, four skills and launchers, and
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

Create a new tree and record a local link for the current project:

```bash
context-tree init --repository acme/context --tree-path ./context-tree
```

Or link a project to an existing, verified checkout:

```bash
context-tree link --project-path ./service --tree-path ./context-tree
```

If `init` omits `--tree-path`, it creates `./REPO`, using the repository name
verbatim as the directory and tree title. Scaffolding is create-only. It runs
ordinary `git init`, configures a credential-free GitHub origin, and creates a
validation workflow pinned to the package version and selected initial branch.
The init skill, rather than the CLI, owns the initial commit and any publication.

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

`stage` fetches the live default branch and creates an isolated worktree at its
exact commit. After edits, `diff` reports all pending changes against the given
base (`HEAD` by default). These are preparation and inspection commands: there
is no CLI publish command. The write skill edits, verifies, reviews, commits,
rebases when necessary, and publishes the result.

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
| `refresh` | Fast-forward a linked tree to its live default branch | `--project-path <path>` (default `.`) |
| `stage` | Prepare an isolated worktree for a write | `--project-path <path>` (default `.`) |
| `diff` | Inspect changes in a prepared worktree | `[tree-path]` (default `.`), `--base <ref>` (default `HEAD`) |
| `init` | Scaffold a new tree | `--repository <owner/repo>`, optional `--tree-path <path>` |
| `policy` | Print the packaged Context Tree policy | None |
| `read` | Read a node or Markdown leaf | `[path]` (default `.`), `--tree-path <path>` (default `.`) |
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
- **Checkout validation:** Linking requires a clean, exact Git root with a safe
  GitHub origin and a fully valid tree. Resolution fails closed for symlinks,
  moved paths, dirty trees, origin mismatches, and invalid roots. `init` has a
  narrow exception for its four new uncommitted scaffold files.
- **Git operations:** Reads fast-forward only. Writes start from a freshly
  fetched default-branch commit in an isolated worktree and never force-push.
  Commit SHAs identify shared snapshots.
- **Hooks:** Session and subagent hooks inject only a resolved tree identity and
  path. They are silent when no link matches and never fetch, clone, or mutate.
  They use only the plugin's packaged CLI and warn if it is unavailable.
- **Write fallback:** The write skill retries bounded concurrent updates. If a
  direct push is denied or retries are exhausted, it opens a conflict-free PR
  from the latest default branch without merging it or requesting reviewers.
  Each write and commit is scoped to one concrete source.

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
