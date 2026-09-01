---
name: context-tree-connect
description: Connect the current project to a managed Context Tree by name, GitHub OWNER/REPO, or an exact disk path.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Connect

Resolve `<skill-directory>` to this skill's directory. First run
`node "<skill-directory>/scripts/context-tree.mjs" --version`. If the packaged
CLI is unavailable, stop and ask the user to reinstall or update the plugin.

Run `node "<skill-directory>/scripts/context-tree.mjs" connect "<name-or-OWNER/REPO>"`
with exactly one managed tree name or GitHub `OWNER/REPO` supplied by the
user. If the user instead supplies an exact disk path to an existing Context
Tree checkout, run
`node "<skill-directory>/scripts/context-tree.mjs" connect --tree-path "<path>"`
instead. Never accept a repository URL, and never infer, guess, or search the
filesystem for a path yourself — only pass through a name, `OWNER/REPO`, or
disk path the user explicitly typed or confirmed. An explicit connect
automatically switches the project's connection. Report the resulting tree
kind and canonical path.

If connection reports `INVALID_TREE` or `DIRTY_TREE`, report the failure. A
managed or GitHub tree must be repaired or committed separately before it can
be selected; for `--tree-path`, the checkout at that exact path must be
repaired or committed in place, since there is no managed tree to fall back
to.
