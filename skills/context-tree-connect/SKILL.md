---
name: context-tree-connect
description: Connect the current project to an existing Context Tree by managed name, GitHub OWNER/REPO, or exact disk path. Use when the tree already exists; context-tree-setup delegates here once the user has chosen a target.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Connect

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Connect exactly one target supplied by the user:

- A managed tree name or GitHub `OWNER/REPO`:
  `context-tree connect "<name-or-OWNER/REPO>" --json`.
- An exact path to an existing Context Tree checkout:
  `context-tree connect --tree-path "<path>" --json`.
  That checkout is attached where it already lives and is never copied, moved,
  or deleted.

Never accept a repository URL, and never infer, guess, or search the filesystem
for a target yourself; pass through only what the user typed or confirmed. An
explicit connect switches the project's connection. Report whether the
connected tree is local or GitHub-backed, with its canonical path.

`connect` also records the tree in the project's own `AGENTS.md`, replacing any
previous Context Tree pointer rather than adding a second one. The result's
`pointer` field reports `written`, `updated`, or `skipped`; when it is not
`skipped`, tell the user that `AGENTS.md` in their project changed.

If connection reports `INVALID_TREE` or `DIRTY_TREE`, report the failure and
stop. The tree must be repaired or committed at its own location before it can
be connected.
