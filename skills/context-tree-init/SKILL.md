---
name: context-tree-init
description: Create and publish a new GitHub-backed Context Tree from an explicit repository identity. Create a private repository by default.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.0"
---

# Context Tree Init

Use this skill only to create a new Context Tree; never update an existing tree.
Require the user to provide a GitHub `OWNER/REPO`, a local destination that is
absent or empty, a tree title, and an initial owner. Always use `main`; do not
accept a configurable branch. Support only `github.com`, not GitHub Enterprise
Server or other forges.

First run `context-tree --version`. If the command is missing, stop and tell the
user to run `npm install --global @first-tree-ai/context-tree`. Never install a
package automatically.

## Preflight

Before creating a directory, initializing Git, committing, or changing GitHub:

1. Run `context-tree policy` and require `schemaVersion: 1`.
2. Validate the explicit `OWNER/REPO`, destination, title, and owner. Require `OWNER/REPO`, not a URL; never accept a credential-bearing repository URL.
3. Use the host's existing `git` and `gh` credentials with non-interactive commands. Run `gh auth status` and stop if GitHub access is unavailable. Never request, store, or print credentials.
4. Confirm that the destination is absent or empty. Run `gh repo view "OWNER/REPO"` and continue only when GitHub explicitly reports that the repository does not exist. Stop on authentication, network, or indeterminate errors.

## Create and publish

1. Run `context-tree init --repository "OWNER/REPO" --tree-path "<destination>" --title "<title>" --owner "<owner>"`. The scaffold always contains the packaged GitHub Actions workflow pinned to the installed package version and filtered to `main`.
2. Run `context-tree verify --tree-path "<destination>"` and require a valid result.
3. Run `git init --initial-branch=main`, add only the scaffolded files, inspect the complete staged diff, and commit. Do not rely on `init.defaultBranch` or other user Git configuration.
4. Run `gh repo create "OWNER/REPO" --private --source "<destination>" --remote origin --push`. Use `--public` instead of `--private` only when the user explicitly requests a public repository. Publish `main` only.
5. Verify that normalized `origin` matches `OWNER/REPO`, the checked-out branch is `main`, the local commit SHA equals `refs/remotes/origin/main`, and `refs/heads/main` exists remotely.

If creation or push has an uncertain result, inspect `gh repo view`, the local
remote, and `git ls-remote` before retrying only the missing operation. Never
delete a GitHub repository or overwrite remote history.
