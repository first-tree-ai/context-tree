# Context Tree

Durable, indexed project context for coding agents. A tree is a directory of Markdown files. It can live in a project's `docs/` directory, a standalone folder, or a subtree of a shared Git repository.

```sh
npm install --global @first-tree-ai/context-tree
cd my-project
context-tree init docs
context-tree read
```

Initialization creates `docs/NODE.md` and `.context-tree.json`. Commit them through the project's normal workflow. Git repositories, project instructions, and CI remain owned by the host project.

## Sources and connections

A project declares tree sources in `.context-tree.json`:

```json
{
  "schemaVersion": 3,
  "trees": [
    { "kind": "directory", "path": "docs" },
    {
      "kind": "git",
      "repository": "acme/knowledge",
      "path": "engineering",
      "ref": "main"
    }
  ]
}
```

Directory sources read the current workspace. Relative paths are portable across clones and worktrees; absolute paths attach external local directories. Git sources use an explicit GitHub repository, subtree, and branch. Git handles authentication through the host's credentials.

```sh
context-tree connect --path docs
context-tree connect acme/knowledge --path engineering --ref main
context-tree sync --offline                   # offline discovery
context-tree sync                            # refresh remote snapshots
context-tree read --tree knowledge
context-tree read architecture --tree docs
context-tree verify --tree docs
context-tree disconnect --tree knowledge
```

Resolution finds the nearest project configuration without crossing the current Git checkout boundary. Without a configuration, commands use the Git root or the supplied directory. With one tree, omit `--tree`. With several, use the directory or repository name: `--tree docs` or `--tree knowledge`. Names are derived, never stored. If a name is ambiguous, the error lists exact selectors: an absolute directory path or a URL such as `https://github.com/acme/knowledge/tree/main/engineering`. These URLs select existing connections; they do not add new ones. `sync` reports each source independently.

`sync` returns a `treeRoot` pinned to a commit for each remote source. Use `read --tree-path <treeRoot>` for a consistent multi-step read. Directory sources expose live content and report whether their subtree has working changes.

## Writing

For a directory source, edit its Markdown files directly and validate them:

```sh
context-tree sync --offline --tree docs       # locate the directory
# Edit Markdown in the returned treeRoot.
context-tree verify --tree docs
```

Commit through the project's normal workflow. Direct editing requires no session or Git repository.

For an isolated review branch, or to edit a managed Git source:

```sh
context-tree write prepare --tree docs
# Edit only the returned treeRoot; retain the returned id.
context-tree write finish <id> --message "Record architecture decision"
```

Write sessions always use a separate worktree. The source must have a committed Git revision and a clean subtree; unrelated project edits can remain. Finishing validates and commits only that subtree, retaining the branch and worktree for review. Merge a directory-source review branch through the project's normal Git workflow.

For a managed Git source, explicitly publish with:

```sh
context-tree write finish <id> --publish
```

Publication pushes to the prepared target branch without force. A rejected push preserves the session and commit. Reconcile against the latest source in a fresh session. Sessions reject changed connections, unexpected branches or commits, and any edited path outside their subtree, including pre-staged, renamed, and untracked files. Do not commit manually inside a session's worktree.

`write abort <id>` removes an empty preparation. It never discards edits or retained commits. Review worktrees remain until integrated and explicitly removed with Git; there is no automatic garbage collection of user work.

## Content format

Every content directory has a `NODE.md` index. Every Markdown document has a nonempty YAML `title`. Only the root requires `schemaVersion: 1` and a nonempty body:

```markdown
---
schemaVersion: 1
title: Project Context
description: Product decisions and engineering context
---

# Project Context

Start with the product and architecture indexes.
```

Optional `soft_links` are tree-root-relative references. Markdown links are relative to their document. `members/<member>/` holds member-specific context. Content must use real files and directories; symlinks are unsupported. Repository infrastructure is excluded from editorial content. See the [specification](docs/specification.md) for exact boundaries and contracts.

## Skills and recurring cleanup

The package includes six portable skills: `init`, `connect`, `read`, `write`, `cleanup`, and `schedule-cleanup`, each prefixed `context-tree-`. A direct global npm install installs them for detected hosts. Local dependency installation leaves home directories alone.

```sh
context-tree skills install                         # detected Claude, Codex, and Pi hosts
context-tree skills install --host codex --project .
context-tree skills uninstall
context-tree cleanup schedule --tree docs --agent codex --every 2h
context-tree cleanup status --tree docs
context-tree cleanup logs --tree docs
context-tree cleanup remove --tree docs
```

Cleanup uses an isolated write session and produces a review branch by default. For managed Git sources, `cleanup schedule ... --publish` authorizes recurring publication. The scheduler is local (launchd on macOS, systemd user timers on Linux), requires a committed Git repository and an installed agent, and skips already processed tree content. Failed work is retained. Removing a schedule disables it and unregisters the job; logs and review work remain.

## Integration and development

CLI JSON and project configuration use schema version **3**; document metadata uses version **1**. Import runtime schemas and derived types from `@first-tree-ai/context-tree/contracts`.

Human-facing commands accept `--json`. `sync`, `write` subcommands, and `skills` subcommands always emit JSON. Failures return a nonzero exit code and sanitized details. `--project-path` selects a project; `read` and `verify` also accept `--tree-path` for direct content access.

```sh
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm check:package
```
