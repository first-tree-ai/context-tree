---
name: context-tree-connect
description: Connect an existing Context Tree directory or a GitHub repository subtree to a project. Use when the user identifies a tree to attach or detach.
---

# Context Tree Connect

Run from the target project:

- Directory: `context-tree connect --path docs --json`.
- GitHub: `context-tree connect owner/repo --path docs --ref main --json`.

For Git sources, obtain the intended branch from the request or inspect the repository; do not guess a publishing target. `--path .` selects a repository-root tree. Authentication uses the host's Git credentials; never put credentials in configuration or command arguments.

Connections live in `.context-tree.json`. Paths inside the project are relative and work across clones and worktrees; an absolute path attaches an external local directory. Report the source. Use its directory or repository name with `--tree`; omit the selector when only one tree is connected. If a name is ambiguous, use an exact source selector shown by the CLI. To detach, use `context-tree disconnect --tree <name-or-source> --json`; content is retained.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
