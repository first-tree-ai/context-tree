---
name: context-tree-cleanup
description: Remove noise, consolidate duplicates, and improve placement throughout a connected Context Tree, including every member directory. Use for an explicit cleanup request or a host-scheduled cleanup pass.
---

# Context Tree Cleanup

Read [the editorial rules](references/editorial.md) before editing.

For a manual pass, select the requested tree and run `context-tree write prepare --tree <name-or-source>`. Work only inside the returned `treeRoot`. Read every normal and member document, apply the editorial rules, and review the complete diff. Run `context-tree write finish <id> --message "Clean up Context Tree content"` to validate and retain a review commit. Include `--publish` only when publication to this managed Git source is already authorized. Directory sources use the host's review and merge workflow.

A host-scheduled run supplies an already prepared tree directory. In that case edit only that directory and report findings; the runner owns validation, commits, and publication. Never start another session from inside it.

Report unresolved contradictions and retained review branches outside the tree. Preserve failed work rather than resetting it.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
