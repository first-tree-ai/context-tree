---
name: context-tree-write
description: Persist durable project knowledge or useful agent memory to a connected Context Tree. Use when the user requests a context update or completed work reveals a reusable decision, constraint, or lesson.
---

# Context Tree Write

Save decisions, constraints, rationale, and reusable lessons. Skip task transcripts, generic advice, temporary status, and details already easy to recover from code. Select the connection and narrowest useful existing location; do not duplicate knowledge across trees.

1. Run `context-tree sync --offline --tree <name-or-source>` from the project and inspect the selected source and `treeRoot`. For a directory source, edit that directory directly unless an isolated review branch is requested. For a Git source or an isolated review branch, run `context-tree write prepare --tree <name-or-source>`; save its session `id` and edit only the returned worktree's `treeRoot`. Preparation refreshes Git sources.
2. Read the root and nearby indexes before editing. Preserve other authors' content and uncertainty. Put personal working memory under the correct `members/<member>/` subtree; avoid inferring an identity.
3. Each content directory has `NODE.md`. Every Markdown document has YAML frontmatter with a nonempty `title`; only the root has `schemaVersion: 1`. Optional `description` summarizes content and `soft_links` contains tree-root-relative references. Keep indexes and links consistent after moves.
4. For direct directory edits, run `context-tree verify --tree-path <treeRoot> --json` and use the project's normal commit workflow when authorized. For an isolated session, run `context-tree write finish <id> --message "Describe the durable update"` to validate and commit a review branch.

Use `write finish <id> --publish` only when the user or host task has authorized pushing to the prepared Git source. Existing authorization is sufficient; do not ask again. Directory sources are published through their host's workflow. A rejected push retains the worktree and commit; inspect the new target and reconcile through a fresh session, without force pushing. Do not stage, commit, switch branches, or change remotes inside managed sessions yourself.

`write abort <id>` removes an empty isolated preparation. It refuses to discard edits or commits. Include the retained path/session in any failure report.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
