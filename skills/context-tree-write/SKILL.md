---
name: context-tree-write
description: Turn a concrete source artifact into the smallest durable Context Tree update using an explicit guarded write plan. Use for source-backed decisions, constraints, ownership changes with human authority, or cross-domain relationships; do not use for unsourced edits, broad audits, initial tree seeding, or First Tree authorization.
---

# Context Tree Write

Require an explicitly supplied or host-authorized tree root and a concrete source artifact. This skill does not establish First Tree Team authority.

## Source gate

Accept a PR/MR, issue, commit discussion, design or decision document, meeting note, pasted source, or evidence-backed audit finding. Without a concrete source, stop without editing.

Apply both tests:

1. Does the source establish or change something future agents must respect?
2. Would it remain true if the triggering implementation were rewritten?

If either answer is no, leave the tree unchanged.

## Workflow

1. Run `context-tree policy` once for the installed package version, then read the source artifact completely enough to recover the durable decision and rationale.
2. Run `context-tree verify --tree-path "<root>" --json`.
3. Read the target, its parent, relevant normal `soft_links`, and ownership context with `context-tree read --json --content`.
4. Prefer editing an existing node. Require explicit human authority for ownership changes, `decisionLocksCode`, or a new top-level domain.
5. Obtain the current `treeDigest` and target file digests from read or audit output.
6. Create a schema-version-1 JSON plan containing `expectedTreeDigest` and explicit create, replace, or delete operations. Supply `expectedSha256` for replace/delete.
7. Run `context-tree write --tree-path "<root>" --plan "<plan>" --dry-run --json`.
8. Inspect the complete proposed diff. Apply the same plan without `--dry-run` only after the plan still matches the intended source and authority.
9. Run `context-tree verify --tree-path "<root>" --json` and inspect `git diff`.

The CLI changes local Markdown only. Use host `git`, `gh`, or `glab` credentials for optional commit, push, or PR/MR work. Set `GIT_TERMINAL_PROMPT=0` for agent-run network commands. Never embed credentials in URLs, plans, commits, logs, or tree content.

Keep one coherent source per change. Record current truth and surviving rationale, not implementation details or delivery history.
