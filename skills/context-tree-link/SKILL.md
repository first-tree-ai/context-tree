---
name: context-tree-link
description: Link the current project to an existing or managed GitHub Context Tree checkout for automatic future resolution.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.5"
---

# Context Tree Link

Use this skill to establish or repair a project link. Never scan the filesystem for a tree. This setup workflow is self-contained: do not invoke the normal context-tree-write skill and do not require `agent_slug`.

## Invocation inputs

- `project_path`: optional project directory; default to the current directory
- `tree_path`: optional existing Context Tree checkout
- `repository`: optional canonical GitHub `OWNER/REPO` to clone or verify

Require either `tree_path` or `repository`. Reject repository URLs. When both are supplied, require the checkout origin to match `repository` exactly after normalization.

Resolve `<skill-directory>` to the plugin skill directory containing this
`SKILL.md`; do not use the project working directory. Run every Context Tree CLI
command through the package-relative `scripts/context-tree.mjs` launcher shown
below. The launcher requires the private CLI bundled in the same plugin package
and never uses a command from `PATH`. First run
`node "<skill-directory>/scripts/context-tree.mjs" --version`. If it reports that
the packaged CLI is unavailable, stop and tell the user to reinstall or update
the Context Tree plugin; never install a package automatically.

## Select the checkout

- Attach: resolve `tree_path` to an absolute path and require an existing clean, non-symlink Git root with a credential-free `github.com` origin.
- Managed clone: parse `repository` as `OWNER/REPO` and clone it into `~/.context-tree/checkouts/OWNER/REPO`. Create parent directories without symlinks. Refuse a non-empty destination and run only `git clone --origin origin -- "https://github.com/OWNER/REPO.git" "<destination>"`. Missing managed checkouts are recreated only through this explicit invocation.

Run `node "<skill-directory>/scripts/context-tree.mjs" verify --tree-path "<tree_path>"` and stop unless it succeeds.

## Record the link

Run `node "<skill-directory>/scripts/context-tree.mjs" link --project-path "<project_path>" --tree-path "<tree_path>"`. Parse and require the link result contract. This writes only the local mapping in `~/.context-tree/connections.json`; it must not edit, commit, push, or open a pull request in the Context Tree repository. Report the linked `OWNER/REPO` and canonical absolute checkout path.

A relink may replace a stored checkout path only when the new checkout verifies as the same tree repository and the old checkout is stale. A second live checkout, including a dirty old checkout, must not replace it.

Use host Git authentication directly for a managed clone. Never request, store, pass, or print credentials or credential-bearing repository URLs.
