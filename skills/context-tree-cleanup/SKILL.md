---
name: context-tree-cleanup
description: Review a connected Context Tree against the write and read principles and fix what is clear (history and raw notes, stale or duplicated claims, misplacement, unbalanced nodes, weak titles and descriptions). Use for an explicit cleanup or review request or a host-scheduled pass.
---

# Context Tree Cleanup

Read [the review rules](references/editorial.md) and the principles of the `context-tree-write` and `context-tree-read` skills before editing.

A host-scheduled run supplies a prepared tree directory. Edit only that directory using the review rules; the runner owns validation, commits, and publication. Do not start another session.

For a manual pass, run `context-tree write prepare --tree <name-or-source>` from the target project. Save the session `id` and apply the review rules inside its `treeRoot`. Run `context-tree write finish <id> --message "Clean up Context Tree content"` to validate and retain a review commit. Include `--publish` only when publication to this managed Git source is authorized. Directory sources use the project's review and merge workflow.

Report retained work with its path and session ID. Preserve failed work rather than resetting it.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
