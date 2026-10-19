---
name: context-tree-write
description: Persist durable project knowledge or useful agent memory to a connected Context Tree. Use when the user requests a context update or completed work reveals a reusable decision, constraint, or lesson.
---

# Context Tree Write

Save decisions, constraints, rationale, and reusable lessons. Skip task transcripts, generic advice, temporary status, and details already easy to recover from code. Select the connection and narrowest useful existing location; do not duplicate knowledge across trees.

1. Run `context-tree prepare-write --tree <name-or-source>` from the project. Use `--isolated` for a review branch in a directory source. Save the returned session `id` and edit only its `treeRoot`; Git sources always return an isolated worktree.
2. Read the root and nearby indexes before editing. Preserve other authors' content and uncertainty. Put personal working memory under the correct `members/<member>/` subtree; avoid inferring an identity.
3. Each content directory has `NODE.md`. Every Markdown document has YAML frontmatter with a nonempty `title`; only the root has `schemaVersion: 1`. Optional `description` summarizes content and `soft_links` contains tree-root-relative references. Keep indexes and links consistent after moves.
4. Run `context-tree finish-write <id> --message "Describe the durable update"`. Workspace mode validates only; the host owns staging and commits. Isolated mode commits a review branch and returns its path and session ID.

Use `finish-write <id> --publish` only when the user or host task has authorized pushing to the prepared Git source. Existing authorization is sufficient; do not ask again. Directory sources are published through their host's workflow. A rejected push retains the worktree and commit; inspect the new target and reconcile through a fresh session, without force pushing. Do not stage, commit, switch branches, or change remotes inside managed sessions yourself.

`abort-write <id>` releases a workspace session or an empty isolated preparation. It refuses to discard edits or commits. Include the retained path/session in any failure report. A successful workspace result still needs the project's normal commit workflow if requested.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
