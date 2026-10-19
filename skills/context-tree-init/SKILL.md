---
name: context-tree-init
description: Initialize a Context Tree directory and connect it to the current project. Use when the user asks to start a new tree, including inside an existing repository.
---

# Context Tree Init

Run from the target project's root: `context-tree init <directory> --json`. The default directory is `context`; `context-tree init docs --json` creates a tree in `docs/`.

This adds a root `NODE.md` and a declaration in `.context-tree.json`. Existing content must already satisfy the tree format; initialization never converts or overwrites documents. If validation fails, inspect the findings and prepare a targeted conversion only within the user's request.

Edit the returned `treeRoot`'s `NODE.md` to explain the tree's scope and navigation. Run `context-tree verify --tree-path <treeRoot> --json`. Commit through the project's normal workflow when authorized. Initialization does not create a repository, commit, push, or alter project instructions.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
