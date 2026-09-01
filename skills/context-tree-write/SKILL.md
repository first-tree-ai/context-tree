---
name: context-tree-write
description: Record a durable decision, constraint, or rationale in the project's Context Tree. Use once a decision is settled and should outlive the current task.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Write

Write only current decisions, constraints, and rationale that would change how
a future agent acts and would remain true if the triggering work were redone.
Do not store source-code detail, task logs, unresolved proposals, or secrets.

Resolve `<skill-directory>` to this skill's directory and run
`node "<skill-directory>/scripts/context-tree.mjs" --version` once per session.
If the packaged CLI is unavailable, stop and ask the user to reinstall or
update the plugin.

1. Run `node "<skill-directory>/scripts/context-tree.mjs" prepare-write`.
2. Edit only the returned `worktreePath`, preserving Context Tree structure and
   making the narrow change the evidence supports.
3. Run `node "<skill-directory>/scripts/context-tree.mjs" finish-write --worktree-path "<worktree-path>" --message "<message>"`.

If `prepare-write` reports `NO_CONNECTION`, invoke `$context-tree-setup` to
create or connect a tree, then prepare again once.

`finish-write` commits every change present in that worktree, so leave nothing
unrelated there. If an operation reports `INVALID_TREE`, run `verify` on the
named path and repair only the content change the user authorized. If
`prepare-write` reports `DIRTY_TREE`, report the tree's uncommitted changes and
stop; never commit or discard the user's pending edits to resolve it.

If `finish-write` reports `WRITE_OUTDATED`, preserve the first worktree, prepare
a fresh worktree, and reapply the intended change once. If the second finish is
also outdated, stop and report both preserved worktree paths. Do not rebase,
loop, push manually, or open a pull request.
