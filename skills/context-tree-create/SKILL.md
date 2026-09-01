---
name: context-tree-create
description: Create and connect a new managed local Context Tree for the current project. Use when the user wants a brand-new tree; context-tree-setup delegates here after confirming the project has none.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Create

Resolve `<skill-directory>` to this skill's directory and run
`node "<skill-directory>/scripts/context-tree.mjs" --version` once per session.
If the packaged CLI is unavailable, stop and ask the user to reinstall or
update the plugin.

Run `node "<skill-directory>/scripts/context-tree.mjs" create`. Report whether
the managed tree was created or already existed, together with its name, path,
and exact commit SHA.

The managed name is derived from the project directory's name. If that name is
already taken, or the project is already connected to a different tree, report
the `connect` command the error supplies and stop. Do not replace or remove the
existing managed tree or connection.

After the tree is created or reused, run
`node "<skill-directory>/scripts/context-tree.mjs" resolve`. When the tree is
local, ask the user whether to publish it as a private GitHub repository. An
explicit prior request to publish counts as confirmation; otherwise a "no"
leaves the tree local, and a "yes" delegates to `$context-tree-publish`. Never
publish without that confirmation.
