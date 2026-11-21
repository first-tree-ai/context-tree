---
name: context-tree-write
description: Persist durable project knowledge or useful agent memory to a connected Context Tree. Use when the user requests a context update or completed work reveals a reusable decision, constraint, or lesson.
---

# Context Tree Write

Save decisions, constraints, rationale, and reusable lessons so a future agent can find what holds now. Skip task transcripts, generic advice, temporary status, and details already easy to recover from code. Select the connection and narrowest useful existing location; do not duplicate knowledge across trees.

## Organize by topic, not by time

Readers search for a subject and trust what they find. Each decision belongs on the node for its subject; a dated log, meeting, or changelog page makes readers replay history to learn what still holds, and leaves replaced decisions looking current.

- Before editing, read the root and nearby indexes, then find and read the node that already covers the topic. Update it rather than adding a parallel one; add a node only when the topic has its own identity.
- When a decision changes, rewrite or remove the claims it replaces in the same change, so the node states the current decision and its surviving rationale. Git keeps the history.
- Follow the organization and writing conventions the tree's root describes.
- At the end of a task, consider whether it settled anything durable. Most tasks did not.

## Planned decisions

Record a decision once it is made, even before code implements it. Describe the target state, and make the first line of the decided section (or of the page, when all of it is unimplemented) `> **Planned — not yet implemented.** Tracking: <issue link or #number>`. Where it conflicts with current behavior, say what it replaces and keep the current description until implementation lands. The tracking issue lists the pages to update; the implementing change removes the marker and rewrites the text as current behavior. Use no other marker form or frontmatter key.

## Writing

Run from the target project. Select a source declared in `.context-tree.json`; omit `--tree` when only one is connected.

- **Directory:** run `context-tree sync --offline --tree <name-or-source>`, edit the returned `treeRoot`, then run `context-tree verify --tree-path <treeRoot> --json`. Use the project's normal commit workflow when authorized.
- **Git source or requested review branch:** run `context-tree write prepare --tree <name-or-source>` directly; it fetches Git sources and requires a committed revision and clean subtree. Save the session `id`, edit only its `treeRoot`, then run `context-tree write finish <id> --message "Describe the durable update"` to validate and retain a review commit.

Preserve other authors' content and uncertainty. Put personal memory under the correct `members/<member>/` subtree; avoid inferring an identity. Never follow symlinks.

Each content directory needs `NODE.md`; every Markdown document needs a YAML `title`. Only the root has `schemaVersion: 1`. Optional `description` summarizes content; `soft_links` are tree-root-relative. Keep indexes and links consistent after moves.

Use `write finish <id> --publish` only when the user or host task has authorized pushing to the prepared Git source. Existing authorization is sufficient; do not ask again. Directory sources are published through their host's workflow. A rejected push retains the worktree and commit; inspect the new target and reconcile through a fresh session, without force pushing. Do not stage, commit, switch branches, or change remotes inside managed sessions yourself.

`write abort <id>` removes an empty isolated preparation. It refuses to discard edits or commits. Include the retained path/session in any failure report.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
