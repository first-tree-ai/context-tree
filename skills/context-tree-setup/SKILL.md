---
name: context-tree-setup
description: Set up a Context Tree for the current project by creating a new managed tree or connecting to an existing one.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Setup

Resolve `<skill-directory>` to this skill's directory. First run
`node "<skill-directory>/scripts/context-tree.mjs" --version`. If the packaged
CLI is unavailable, stop and ask the user to reinstall or update the plugin.

Run `node "<skill-directory>/scripts/context-tree.mjs" resolve`. If it
succeeds, report the connected tree kind and canonical path and stop; the
project is already set up.

If `resolve` reports `NO_CONNECTION`, ask the user whether to create a new
Context Tree or connect an existing one:

- To create, delegate to `$context-tree-create`.
- To connect, run `node "<skill-directory>/scripts/context-tree.mjs" list`.
  When managed trees exist, offer the listed names alongside a GitHub
  `OWNER/REPO` and an exact disk path. When no managed trees exist, offer only
  a GitHub `OWNER/REPO` and an exact disk path. Delegate the selected target
  to `$context-tree-connect`; never accept a repository URL. An explicit
  connect automatically switches the project's connection.

Never publish a tree without explicit user confirmation. If `resolve` reports
`CORRUPT_CONNECTION` or `STALE_CONNECTION`, report the failure and stop; do
not repair or replace state automatically.