---
name: context-tree-create
description: Create and connect a new Context Tree for a project. Keep it local by default, or publish it privately on GitHub when requested; use connect for a tree that already exists.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Create

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Use the original project's stable absolute path, including when setup delegates
here. Creating a tree defaults to local-only unless the user chose GitHub; a
local-only choice does not invite a follow-up publication question.

Run `context-tree create --project-path "<project>" --json`. Report whether the
managed tree was created or already existed, together with its name, path, and
exact commit SHA.

The managed name is derived from the project directory's name. If that name is
already taken, or the project is already connected to a different tree, report
the `connect` command the error supplies and stop. Do not replace or remove the
existing managed tree or connection.

If the user requested a new private GitHub tree, run
`context-tree resolve --project-path "<project>" --json` after creation or reuse.
If local, delegate to `$context-tree-publish` with the same project path and any
supplied `OWNER/REPO`. That prior choice is publication authorization; do not
ask again. If already GitHub-backed, report that state without republishing.
Otherwise leave the tree local without asking about GitHub.

Return success to setup or the pending read/write so it can resume. On any
failure, return the error and any state already created; do not report the
requested setup complete or retry automatically.
