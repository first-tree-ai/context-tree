---
name: context-tree-write
description: Persist durable project knowledge or useful agent memory to a connected Context Tree. Use when the user requests a context update or completed work reveals a reusable decision, constraint, or lesson.
---

# Context Tree Write

Save decisions, constraints, rationale, and reusable lessons so a future agent can find what holds now. Write what a future agent must respect when deciding, and what would still hold if the implementation were rewritten; details that rot with the next refactor stay in the code. Skip task transcripts, generic advice, temporary status, and details already easy to recover from code. Select the connection and narrowest useful existing location; do not duplicate knowledge across trees.

## Current state, organized by topic

A tree is useful only while it is fresh: readers search for a subject and trust what they find. Record what holds now and why. History is low-density information that readers must replay to learn what still holds, and it leaves replaced decisions looking current, so changelogs, decision logs, and meeting logs do not belong in the tree; Git and the source records keep them. Each decision belongs on the node for its subject, which keeps lookups short and updates in one place.

- Do not record history, raw logs, or raw meeting notes and transcripts. Distill what they settled into the topic nodes they concern, as current state.
- Record only what was settled: not proposals still under discussion, guesses, or your own unconfirmed inferences, and never secrets. Do not turn a one-off request into a standing rule.
- Node text carries no PR numbers, dates, or delivery status; Git and pull requests keep those. Actionable future work belongs in an issue, not in the tree.
- Before editing, read the root and nearby indexes, then find and read the node that already covers the topic. Update it rather than adding a parallel one; add a node only when the topic has its own identity.
- When a decision spans two areas, keep it in the more specific one and link to it from the other.
- Keep the edit as narrow as the decision. Change other nodes only where this decision makes them wrong: a contradicting claim, an index entry or description, or a link. Leave unaffected neighbors alone.
- When a decision changes, rewrite or remove the claims it replaces in the same change, so the node states the current decision and its surviving rationale. Git keeps the history.
- Follow the organization and writing conventions the tree's root describes.
- At the end of a task, consider whether it settled anything durable. Most tasks did not.

## Keep the tree balanced

Keep information spread evenly: no node should be far larger or denser than its siblings. Every reader pays for a whole page to use part of it, and an oversized node hides what it holds from the index, so a page should hold one topic a reader needs as a unit. Split when the page has become hard to scan, when it holds several topics a reader would want separately, or when other nodes need to link to one part of it; not before, because premature structure costs more than missing structure.

- Give each topic its own node with a noun-phrase title and a description that lets a reader decide from the index whether to open it.
- Keep a short summary and the links in the parent. A topic with several cohesive pages of its own becomes a directory with a `NODE.md` index.
- Move content rather than copying it, and fix indexes, `soft_links`, and incoming links in the same change.

## Planned decisions

Record a decision once it is made, even before code implements it. Describe the target state, and make the first line of the decided section (or of the page, when all of it is unimplemented) `> **Planned — not yet implemented.** Tracking: <issue link or #number>`. Where it conflicts with current behavior, say what it replaces and keep the current description until implementation lands. The tracking issue lists the pages to update; the implementing change removes the marker and rewrites the text as current behavior. Use no other marker form or frontmatter key.

## Writing

Run from the target project. Select a source declared in `.context-tree.json`; omit `--tree` when only one is connected.

- **Directory:** run `context-tree sync --offline --tree <name-or-source>`, edit the returned `treeRoot`, then run `context-tree verify --tree-path <treeRoot> --json`. Use the project's normal commit workflow when authorized.
- **Git source or requested review branch:** run `context-tree write prepare --tree <name-or-source>` directly; it fetches Git sources and requires a committed revision and clean subtree. Save the session `id`, edit only its `treeRoot`, then run `context-tree write finish <id> --message "Describe the durable update"` to validate and retain a review commit.

Preserve other authors' content and uncertainty. Never follow symlinks.

Each content directory needs `NODE.md`; every Markdown document needs a YAML `title`. Only the root has `schemaVersion: 1`. Optional `description` summarizes content; `soft_links` are tree-root-relative. Keep indexes and links consistent after moves.

Use `write finish <id> --publish` only when the user or host task has authorized pushing to the prepared Git source. Existing authorization is sufficient; do not ask again. Directory sources are published through their host's workflow. A rejected push retains the worktree and commit; inspect the new target and reconcile through a fresh session, without force pushing. Do not stage, commit, switch branches, or change remotes inside managed sessions yourself.

`write abort <id>` removes an empty isolated preparation. It refuses to discard edits or commits. Include the retained path/session in any failure report.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
