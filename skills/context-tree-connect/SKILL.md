---
name: context-tree-connect
description: Connect the current project to an existing Context Tree by managed name, GitHub OWNER/REPO, or exact disk path. Use when the tree already exists; context-tree-setup delegates here once the user has chosen a target.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Connect

Resolve `<skill-directory>` to this skill's directory and run
`node "<skill-directory>/scripts/context-tree.mjs" --version` once per session.
If the packaged CLI is unavailable, stop and ask the user to reinstall or
update the plugin.

Connect exactly one target supplied by the user:

- A managed tree name or GitHub `OWNER/REPO`:
  `node "<skill-directory>/scripts/context-tree.mjs" connect "<name-or-OWNER/REPO>"`.
- An exact path to an existing Context Tree checkout:
  `node "<skill-directory>/scripts/context-tree.mjs" connect --tree-path "<path>"`.
  That checkout is attached where it already lives and is never copied, moved,
  or deleted.

Never accept a repository URL, and never infer, guess, or search the filesystem
for a target yourself; pass through only what the user typed or confirmed. An
explicit connect switches the project's connection. Report whether the
connected tree is local or GitHub-backed, with its canonical path.

If connection reports `INVALID_TREE` or `DIRTY_TREE`, report the failure and
stop. The tree must be repaired or committed at its own location before it can
be connected.
