---
name: context-tree-push
description: Publish a local Context Tree by creating a new private GitHub repository and pushing committed local state.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.5"
---

# Context Tree Push

Use this skill to publish an existing local Context Tree to GitHub. When the
tree has no origin, the CLI creates a new private `OWNER/REPO` repository,
configures the credential-free origin, pushes the current branch, and sets the
default branch. When an origin already exists, the CLI pushes through it. The
skill never commits on the caller's behalf, never merges, never deletes or
overwrites remote history, and never force-pushes.

## Invocation inputs

- `repository`: optional canonical `OWNER/REPO`
- `tree_path`: optional Context Tree root; default to the current directory

## Resolve inputs

1. Use canonical `OWNER/REPO` already supplied by the user or available from unambiguous authoritative task context. If it is missing, partial, inferred, or conflicts with another authoritative value, ask the user; never invent, combine, or replace it. Reject repository URLs so credentials cannot enter commands or logs. Support only `github.com`, not GitHub Enterprise Server or other forges.
2. Resolve `<skill-directory>` to the plugin skill directory containing this
   `SKILL.md`, not the project working directory. Run every Context Tree CLI
   command through the package-relative `scripts/context-tree.mjs` launcher shown
   below. The launcher requires the private CLI bundled in the same plugin package
   and never uses a command from `PATH`. First run
   `node "<skill-directory>/scripts/context-tree.mjs" --version`. If it reports
   that the packaged CLI is unavailable, stop and tell the user to reinstall or
   update the Context Tree plugin; never install a package automatically. The
   host's `git` and an authenticated `gh` session for `github.com` are required;
   the CLI owns every Git and GitHub operation.

## Push

1. Run
   `node "<skill-directory>/scripts/context-tree.mjs" push "OWNER/REPO" --tree-path "<tree_path>"`;
   omit the argument only to push through an existing origin. Parse the result
   and require the push result contract, including `branch`, `sha`,
   `defaultBranch`, `remote`, and `uncommittedFiles`. If `uncommittedFiles` is
   greater than zero,
   disclose that uncommitted local changes were not published; pushing ignores
   them and never stages or commits.
2. On failure, stop and report. If GitHub reports that `OWNER/REPO` already exists, stop; never adopt, delete, or retry against an existing repository without explicit user authorization. If creation or push has an uncertain result, inspect `gh repo view`, the local remote, and `git ls-remote` for the pushed branch before retrying only the missing operation. Never delete a GitHub repository or overwrite remote history.
3. Report the created private repository identity, canonical URL, default
   branch, and pushed commit `sha`.

Use the host's existing `git` and `gh` setup directly. If an attempted operation
fails, never request, store, or print credentials or credential-bearing
repository URLs.
