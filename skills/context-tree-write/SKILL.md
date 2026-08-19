---
name: context-tree-write
description: Publish a source-backed Context Tree change through an isolated GitHub pull request.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.0"
---

# Context Tree Write

Require a concrete source artifact plus an explicitly authorized GitHub
`OWNER/REPO` and base branch. Accept a PR, issue, commit discussion, decision
document, meeting note, or pasted source. Without concrete evidence, stop.
A Git remote proves identity, not user authority.

First run `context-tree --version`. If the command is missing, stop and tell the
user to run `npm install --global @first-tree-ai/context-tree`. Never install a
package automatically.

Apply both durability tests: the source must establish something future agents
must respect, and it must remain true if the triggering implementation is
rewritten. Otherwise leave the tree unchanged.

## Fresh isolated base

1. Run `context-tree policy` and require `schemaVersion: 1`.
2. Require canonical `OWNER/REPO`, not a repository URL, and use existing host `git` and `gh` credentials with `GIT_TERMINAL_PROMPT=0`.
3. Verify any management checkout's normalized `origin`. Fetch the explicit base branch and resolve `refs/remotes/origin/<base>` to its exact Git commit SHA. A stale checkout may not become a write.
4. Create a unique task branch and agent-owned isolated worktree at that exact fetched commit. Never edit the shared checkout.
5. Require `git status --porcelain` to be empty and run `context-tree verify --tree-path "<root>"` before reading semantic content.

If the base is invalid, block all semantic edits. Continue only for an explicit
repair request, and make a repair-only PR whose changes are limited to exact
validator findings supported by existing authorized evidence. Never invent
owners, decisions, structure, or business content. The complete repaired tree
must pass verification before publication.

## Source-backed edit

1. Read the source and the minimum target, parent, relationship, and ownership context with `context-tree read --content`.
2. Prefer an existing node. Require explicit authority for ownership changes, locked decisions, or a new top-level domain.
3. Edit only the necessary regular, non-symlink Markdown files directly in the isolated worktree. Preserve path containment and never replace or traverse symlinks.
4. Run `context-tree verify --tree-path "<root>"` on the final tree.
5. Inspect the complete `git diff`, including every changed path and full patch. Stop if it contains anything outside the authorized Context Tree change.

## GitHub publication

1. Run repository-prescribed checks relevant to the changed tree.
2. Commit the verified diff on the task branch.
3. Push with `git push --set-upstream origin "<task-branch>"`. Use a non-force push; never force push or push directly to the base branch.
4. Open a GitHub PR targeting the explicit base with `gh pr create --base "<base>" --head "<task-branch>"`. Never merge automatically and never request reviewers automatically.

If push or PR creation has an unknown result, inspect the remote branch and
existing PRs before retrying only a missing operation. Leave conflicts and
outdated-branch handling to GitHub. Keep one coherent source per change and
remove an agent-owned worktree only when it is clean; never remove a pre-existing
or dirty worktree.
