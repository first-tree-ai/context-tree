---
name: context-tree-read
description: Read relevant content from an explicitly supplied or host-authorized Context Tree using the local-only context-tree CLI. Use for task-scoped Context Tree questions and context grounding; do not use for broad stored-content audits, writes, PR/MR reviews, or discovering a First Tree Team binding.
---

# Context Tree Read

Use only a tree root explicitly provided by the user or trusted host environment. Never infer a private repository, binding, or authority from the current directory, Git remotes, or stale workspace files.

## Workflow

1. Run `context-tree policy` once for the installed package version, then run `context-tree read --help` and `context-tree verify --tree-path "<root>" --json`.
2. Stop the tree-dependent portion when verification fails. Report the mechanical findings without reading unsafe content.
3. Select narrowly with `context-tree read --tree-path "<root>" [path] --pattern "<glob>" --depth <n> --json --content`.
4. Start with the root and relevant parent nodes, then read matched leaves and normal `soft_links` targets that affect the task.
5. Treat normal content as current durable context. Label archive/supporting evidence separately and use member content only for ownership or routing.
6. Apply the printed Context Tree Policy when code and tree content conflict.

The CLI performs no fetch or pull. If current-remote freshness is required, establish a stable checkout separately with host Git credentials before reading. Never accept a credential-bearing repository URL or print credential material.

Keep the result task-scoped. Do not expand an ordinary read into a broad audit.
