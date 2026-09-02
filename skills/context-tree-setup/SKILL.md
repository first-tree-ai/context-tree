---
name: context-tree-setup
description: Create or connect a Context Tree for the current project. Use when the project has no Context Tree yet, or when another Context Tree operation reports NO_CONNECTION.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Setup

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Run `context-tree resolve --json`. If it succeeds, report whether the tree is local or
GitHub-backed, with its canonical path, and stop; the project is already set up.

If `resolve` reports `NO_CONNECTION`, ask the user whether to create a new
Context Tree or connect an existing one:

- To create, delegate to `$context-tree-create`.
- To connect, run `context-tree list --json` and offer every listed managed name, a
  GitHub `OWNER/REPO`, and an exact disk path. Delegate the chosen target to
  `$context-tree-connect`, which owns the rules for accepting it.

Never publish a tree without explicit user confirmation. If `resolve` reports
`CORRUPT_CONNECTION`, `STALE_CONNECTION`, `DIRTY_TREE`, or `INVALID_TREE`,
report the failure and stop; do not repair or replace state automatically.
