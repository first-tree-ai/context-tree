---
name: context-tree-create
description: Create a uniquely named managed local Context Tree for the current project.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Create

Resolve `<skill-directory>` to this skill's directory. First run
`node "<skill-directory>/scripts/context-tree.mjs" --version`. If the packaged
CLI is unavailable, stop and ask the user to reinstall or update the plugin.

Run `node "<skill-directory>/scripts/context-tree.mjs" create`. Parse the
versioned result and report whether the managed tree was created or already
existed, together with its name, path, and exact commit SHA.

If the derived managed name is occupied, or the project is already connected to
a different tree, report the named `connect` command from the error. Do not
replace or remove the existing managed tree or connection.

After the tree is created or reused, run
`node "<skill-directory>/scripts/context-tree.mjs" resolve` and inspect the
resulting connection. When the tree is local, ask the user whether to publish
it as a private GitHub repository. An explicit prior request to publish counts
as confirmation; otherwise a "no" leaves the tree local, and a "yes" delegates
to `$context-tree-publish`. Never publish without that confirmation.
