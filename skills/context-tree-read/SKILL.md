---
name: context-tree-read
description: Read task-scoped content from an explicitly authorized GitHub Context Tree checkout.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.0"
---

# Context Tree Read

Require an explicitly authorized GitHub `OWNER/REPO`, branch, and local
destination. Never infer authorization from the current directory, a remote, or
workspace files. A Git remote proves identity, not user authority.

First run `context-tree --version`. If the command is missing, stop and tell the
user to run `npm install --global @first-tree-ai/context-tree`. Never install a
package automatically.

## Checkout and freshness

1. Run `context-tree policy` and require `schemaVersion: 1`.
2. Reject repository URLs as identity input; require canonical `OWNER/REPO`, so credential-bearing URLs cannot enter commands or logs.
3. If the checkout is absent, clone the explicit branch from `https://github.com/OWNER/REPO.git` with host Git credentials and `GIT_TERMINAL_PROMPT=0`.
4. Before reusing a checkout, require a clean worktree with `git status --porcelain`, then compare its normalized `origin` and current branch with the explicit inputs. Reject mismatches, detached HEAD, symlinks at the checkout root, and implicit repository discovery.
5. Run `git pull --ff-only origin "<branch>"`, then record `git rev-parse HEAD`. Do not merge, reset, switch branches, or clean files.

If GitHub is unavailable, stop by default. Continue only when the user
explicitly authorizes a stale read of this already verified identity and branch.
Require the worktree to remain clean, label every result `STALE`, report the
refresh failure, and report the exact local commit SHA. A stale checkout is
read-only and must never be reused as the starting point for a write.

## Scoped read

1. Run `context-tree read --help`, then `context-tree verify --tree-path "<root>"`.
2. If verification fails, report the mechanical findings and stop without reading semantic content.
3. Select narrowly with `context-tree read --tree-path "<root>" [path] --pattern "<glob>" --depth <n> --content`.
4. Start with the root and relevant parents, then matched leaves and normal `soft_links` targets. Request member or archive-supporting classes only when required.
5. Apply the packaged policy when code and tree content conflict, and include the recorded Git commit SHA with the result.

The CLI performs no Git or GitHub operations. Keep the result task-scoped.
