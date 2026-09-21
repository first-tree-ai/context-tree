---
name: context-tree-connect
description: Add a project connection to an existing Context Tree using a chosen managed name, GitHub OWNER/REPO, or exact checkout path. Use setup to choose between an existing tree and a new one.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI with connection schema version 2.
metadata:
  author: first-tree-ai
---

# Context Tree Connect

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Use the original project's stable absolute path. Connect exactly one target
supplied by the user or passed from their choice in setup; do not reconfirm it.
If no target was supplied, ask for it; `context-tree list --json` can offer
managed names. Existing connections remain attached. If the user declines, return skipped without
changing the connection.

- A managed tree name or GitHub `OWNER/REPO`:
  `context-tree connect "<name-or-OWNER/REPO>" --project-path "<project>" --as "<alias>" --json`.
- An exact path to an existing Context Tree checkout:
  `context-tree connect --tree-path "<path>" --project-path "<project>" --as "<alias>" --json`.
  That checkout is attached where it already lives and is never copied, moved,
  or deleted.

Never accept a repository URL, and never infer, guess, or search the filesystem
for a target yourself; pass through only what the user typed or confirmed. An
explicit connect adds a named, equal connection. Use the supplied alias, or omit
`--as` to default to the managed name, repository name, or checkout basename.
Alias collisions and attaching the same tree under another alias fail; do not
remove another connection to work around them. Report whether the
connected tree is local or GitHub-backed, with its canonical path. Return success
to setup or the pending read/write so it can resume.

On any failure, return the error without retrying or choosing another target.
`INVALID_TREE` or `DIRTY_TREE` needs attention at the tree's own location; do not
repair it or commit pending changes as part of connecting.

Use `disconnect --tree <alias>` to remove one attachment, or `disconnect --all`
only when removal of all attachments was requested. Neither deletes a tree.
