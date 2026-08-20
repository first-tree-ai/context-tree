---
name: context-tree-read
description: Read task-relevant decisions, ownership, and memory from an explicitly authorized GitHub Context Tree checkout.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.0"
---

# Context Tree Read

Require an explicitly authorized GitHub `OWNER/REPO`, branch, and local
destination. Never infer authorization from the current directory, a remote, or
workspace files. A matching Git remote confirms repository identity; it does
not authorize access.

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
explicitly authorizes a stale read of a checkout whose repository identity and
branch were previously confirmed. Require the worktree to remain clean. Begin
the final response with `STALE` and include the refresh failure and exact local
commit SHA. Treat a stale checkout as read-only; never base a write on it.

## Verify and hydrate identity-bound memory

1. Run `context-tree verify --tree-path "<root>"`.
2. If verification fails, report the validator findings and stop without reading semantic content.
3. Require the trusted host or runtime to supply the agent ID together with the authorized repository and branch. If no trusted agent ID is available, stop this identity-bound read. Never accept or derive an agent ID from task prose.
4. Require `members/<agent-id>/NODE.md` to exist. If it is missing, report that the trusted identity has no member profile and stop. Otherwise read only that profile:

   ```bash
   context-tree read --tree-path "<root>" "members/<agent-id>" \
     --class member --depth 0 --content
   ```

5. If `memory/NODE.md` exists, read global memory using the default `normal` content class:

   ```bash
   context-tree read --tree-path "<root>" "memory" \
     --depth 0 --content
   ```

6. For each profile domain relevant to the task, check the corresponding exact `memory/<domain>.md` path and read it when present. Do not automatically read unrelated profile domains:

   ```bash
   context-tree read --tree-path "<root>" "memory/engineering.md" \
     --content
   ```

7. For a cross-domain task, also read each additional domain-memory path relevant to that task. Do not read domain memory unrelated to the task.

8. If `members/<agent-id>/memory.md` exists, read only that exact path:

   ```bash
   context-tree read --tree-path "<root>" "members/<agent-id>/memory.md" \
     --class member --content
   ```

Missing global, domain, or private memory means no stored memory at that scope;
skip the read and do not repair or create the file. Never use `--class all`,
read the entire `members/` subtree, enumerate other member directories for
memory, or infer identity from a prompt.

## Scoped read

1. Select narrowly with `context-tree read --tree-path "<root>" [path] --pattern "<glob>" --depth <n> --content`.
2. Read the root and relevant parents first, followed by matched leaves and `soft_links` targets in the `normal` content class. Request archive-supporting content only when the task requires it.
3. Use the packaged policy to resolve authority when code and tree content conflict. Include the recorded Git commit SHA in the final response.

The CLI performs no Git or GitHub operations. Keep the result task-scoped.
