---
name: context-tree-write
description: Write a durable Context Tree decision from concrete evidence.
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

Resolve `<skill-directory>` to this skill's directory. First run
`node "<skill-directory>/scripts/context-tree.mjs" --version`. If the packaged
CLI is unavailable, stop and ask the user to reinstall or update the plugin.

1. Run `node "<skill-directory>/scripts/context-tree.mjs" prepare-write`.
2. Edit only the returned `worktreePath`, preserving Context Tree structure and
   applying the narrow semantic change supported by the evidence.
3. Run `node "<skill-directory>/scripts/context-tree.mjs" finish-write --worktree-path "<worktree-path>" --message "<message>"`.

If `prepare-write` reports `NO_CONNECTION`, invoke `$context-tree-setup` to
create or connect a tree, then prepare again once.

Invocation of `finish-write` authorizes every pending change in that worktree.
If an operation reports invalid tree content, run `verify` on the worktree and
repair only when the user authorized that content change.

If `finish-write` reports `WRITE_OUTDATED`, preserve the first worktree, prepare
a fresh worktree, and reapply the intended semantic change once. If the second
finish is also outdated, stop and report both preserved worktree paths. Do not
rebase, loop, push manually, or open a pull request.
