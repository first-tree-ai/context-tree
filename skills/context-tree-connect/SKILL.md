---
name: context-tree-connect
description: Connect or switch a project to an existing Context Tree using a chosen managed name, GitHub OWNER/REPO, or exact checkout path. Use setup to choose between an existing tree and a new one.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Connect

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Use the original project's stable absolute path. Connect exactly one target
supplied by the user or passed from their choice in setup; do not reconfirm it.
If no target was supplied, ask for it; `context-tree list --json` can offer
managed names. For an explicit switch, ask which target to use even if the
project already has a connection. If the user declines, return skipped without
changing the connection.

- A managed tree name or GitHub `OWNER/REPO`:
  `context-tree connect "<name-or-OWNER/REPO>" --project-path "<project>" --json`.
- An exact path to an existing Context Tree checkout:
  `context-tree connect --tree-path "<path>" --project-path "<project>" --json`.
  That checkout is attached where it already lives and is never copied, moved,
  or deleted.

Never accept a repository URL, and never infer, guess, or search the filesystem
for a target yourself; pass through only what the user typed or confirmed. An
explicit connect switches the project's connection. Report whether the
connected tree is local or GitHub-backed, with its canonical path. Return success
to setup or the pending read/write so it can resume.

On any failure, return the error without retrying or choosing another target.
`INVALID_TREE` or `DIRTY_TREE` needs attention at the tree's own location; do not
repair it or commit pending changes as part of connecting.
