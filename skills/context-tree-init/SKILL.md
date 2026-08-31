---
name: context-tree-init
description: Create a local Context Tree with a committed scaffold and a machine-local project link; publication to GitHub happens later.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.5"
---

# Context Tree Init

Use this skill only to create a new Context Tree; never update an existing tree.
Init is local-only: it scaffolds the files, commits them on Git's effective
default branch, and links the current project when its identity is unambiguous.
It never configures a Git remote, contacts GitHub, or publishes. Publication to
a private GitHub repository happens later through the context-tree-push skill.

## Invocation inputs

- `name`: local tree name, a safe single path segment
- `tree_path`: optional absent or empty destination; default to `./name`

## Resolve inputs

1. Use a `name` already supplied by the user or available from unambiguous authoritative task context. If it is missing, partial, inferred, or conflicts with another authoritative value, ask the user; never invent, combine, or replace it.
2. If `tree_path` is omitted, use `./name`. Require the resolved destination to
   be absent or empty and preserve path-containment and symlink fail-closed
   behavior. Init records an unambiguous current project identity only in the
   machine-local links file; it never embeds the source-project association in
   the Context Tree.
3. Resolve `<skill-directory>` to the plugin skill directory containing this
   `SKILL.md`, not the project working directory. Run every Context Tree CLI
   command through the package-relative `scripts/context-tree.mjs` launcher shown
   below. The launcher requires the private CLI bundled in the same plugin package
   and never uses a command from `PATH`. First run
   `node "<skill-directory>/scripts/context-tree.mjs" --version`. If it reports
   that the packaged CLI is unavailable, stop and tell the user to reinstall or
   update the Context Tree plugin; never install a package automatically. Git is
   also required because init runs ordinary `git init` and uses Git's effective default-branch configuration for the initial branch and workflow.

## Scaffold

1. Run
   `node "<skill-directory>/scripts/context-tree.mjs" init "<name>" --tree-path "<tree_path>"`
   from the project directory and treat its JSON scaffold result as authoritative.
   Parse the complete result, require it to match the scaffold result contract
   including the `branch` and `commit` fields, and require `verification.ok === true`.
   If the result is malformed, does not match the contract, or contains a failed
   verification, stop and preserve the generated repository for inspection. The
   tree root `NODE.md` must contain no source-project association.
2. The CLI creates the Git repository with ordinary `git init`, and commits exactly `NODE.md`, `AGENTS.md`, `CLAUDE.md`, and `.github/workflows/validate-context-tree.yml` on the effective default branch,
   and reports the commit SHA. Do not run `git init` again, do not configure a remote, and do not amend or replace the commit.
3. Run `node "<skill-directory>/scripts/context-tree.mjs" resolve --project-path "$PWD"`
   when the project identity was unambiguous. Report the tree path, default
   branch, commit SHA, and that the mapping exists only in
   `~/.context-tree/connections.json`. State explicitly that no GitHub repository was created and that the context-tree-push skill publishes the tree later.

If any Git operation fails, stop and preserve the local files and repository for
inspection. Never request, store, or print credentials.
