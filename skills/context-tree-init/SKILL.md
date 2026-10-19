---
name: context-tree-init
description: Initialize a Context Tree directory and connect it to the current project. Use when the user asks to start a new tree, including inside an existing repository.
---

# Context Tree Init

Run `context-tree init <directory> --json` from the project. Default directory is `context`; its name is derived from the directory. Use `--project-path` when targeting another project. To create a tree in the project's `docs/` directory, run `context-tree init docs --json` from the project root.

This adds a root `NODE.md` and a declaration in `.context-tree.json`. Existing content must already satisfy the tree format; initialization never converts or overwrites documents. If validation fails, inspect the findings and prepare a targeted conversion only within the user's request.

Edit the root to explain the tree's scope and navigation. Run `context-tree verify --tree <name-or-source> --json`. Commit through the host project's normal workflow when authorized. Initialization does not create a repository, commit, push, or alter project instructions.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
