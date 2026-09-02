---
name: context-tree-create
description: Create and connect a new managed local Context Tree for the current project. Use when the user wants a brand-new tree; context-tree-setup delegates here after confirming the project has none.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Create

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Run `context-tree create --json`. Report whether the managed tree was created or
already existed, together with its name, path, and exact commit SHA.

The managed name is derived from the project directory's name. If that name is
already taken, or the project is already connected to a different tree, report
the `connect` command the error supplies and stop. Do not replace or remove the
existing managed tree or connection.

`create` also records the tree in the project's own `AGENTS.md`, so later
sessions and other agents find it without any host-specific setup. The result's
`pointer` field reports `written`, `updated`, or `skipped`; when it is not
`skipped`, tell the user that `AGENTS.md` in their project changed.

After the tree is created or reused, run `context-tree resolve --json`. When the tree is
local, ask the user whether to publish it as a private GitHub repository. An
explicit prior request to publish counts as confirmation; otherwise a "no"
leaves the tree local, and a "yes" delegates to `$context-tree-publish`. Never
publish without that confirmation.
