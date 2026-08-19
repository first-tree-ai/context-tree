---
name: context-tree-audit
description: Audit an explicitly supplied Context Tree scope for mechanical problems, drift, contradictions, duplication, density, metadata, placement, and relationship issues. Use only for an explicit broad or scoped audit request; default to report-only and do not use for ordinary reads, source-backed writes, initial seeding, or First Tree PR/MR review.
---

# Context Tree Audit

Default to report-only. Create follow-up artifacts or tree changes only when the user explicitly authorizes maintenance.

## Stable input

Use an explicitly supplied or host-authorized tree root. For an audit of current remote truth:

1. Require a credential-free remote and explicit branch.
2. Use host Git credentials with `GIT_TERMINAL_PROMPT=0`.
3. Fetch the branch, resolve its exact commit, and create an agent-owned detached worktree.
4. Keep every discovery and evidence read fixed to that commit.

If freshness cannot be authenticated or confirmed, audit the identified local state only and say it is not a current-remote audit. Never expose credential output.

## Workflow

1. Run `context-tree policy` once for the installed package version, then run `context-tree verify --tree-path "<root>" --json`.
2. Run `context-tree audit --tree-path "<root>" [path] --json` to capture the tree digest, inventory, metadata, relationships, and mechanical findings.
3. When verification passes, read only the requested normal scope plus the minimum parent, sibling, relationship, source, and member evidence needed.
4. Check for stale or contradictory claims, duplicated canonical truth, misleading metadata, misplaced decisions, excessive density, broken relationships, and source-boundary violations.
5. Treat suspicion as uncertainty, not evidence.

For every semantic finding, report:

- exact path or relationship;
- applicable policy rule;
- current claim and concrete problem;
- verifiable evidence;
- confidence: mechanical, strong, uncertain, or human-authority;
- recommended action.

In maintenance mode, turn a coherent evidence-backed finding into a concrete source artifact and hand it to `context-tree-write`. Do not edit directly from the audit workflow. Never change ownership, locked decisions, repository governance, or review state without the matching explicit authority.

Remove an audit worktree with ordinary `git worktree remove`; never force-remove a dirty worktree.
