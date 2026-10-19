---
name: context-tree-cleanup
description: Remove noise, consolidate duplicates, and improve placement throughout a connected Context Tree, including every member directory. Use for an explicit cleanup request or a host-scheduled cleanup pass.
---

# Context Tree Cleanup

Read [the editorial rules](references/editorial.md) before editing.

A host-scheduled run supplies a prepared tree directory. Edit only that directory using the editorial rules; the runner owns validation, commits, and publication. Do not start another session.

For a manual pass, run `context-tree write prepare --tree <name-or-source>` from the target project. Save the session `id` and apply the editorial rules inside its `treeRoot`. Run `context-tree write finish <id> --message "Clean up Context Tree content"` to validate and retain a review commit. Include `--publish` only when publication to this managed Git source is authorized. Directory sources use the project's review and merge workflow.

Report retained work with its path and session ID. Preserve failed work rather than resetting it.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
