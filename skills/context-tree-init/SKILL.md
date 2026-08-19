---
name: context-tree-init
description: Create and publish a new private GitHub-backed Context Tree from an explicit repository identity.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.0"
---

# Context Tree Init

Create only. Require the user to explicitly provide a GitHub `OWNER/REPO`, empty
local destination, tree title, and initial owner. Every new repository uses
`main`; do not accept a configurable branch. Accept only
`github.com`; GitHub Enterprise Server and other forges are unsupported.
A Git remote proves identity, not user authority.

First run `context-tree --version`. If the command is missing, stop and tell the
user to run `npm install --global @first-tree-ai/context-tree`. Never install a
package automatically.

## Preflight

Before creating a directory, initializing Git, committing, or changing GitHub:

1. Run `context-tree policy` and require `schemaVersion: 1`.
2. Validate the explicit `OWNER/REPO`, destination, title, and owner. Do not accept a URL in place of `OWNER/REPO`; this avoids credential-bearing repository URLs entirely.
3. Use the host's existing `git` and `gh` credentials with non-interactive commands. Run `gh auth status` and stop if GitHub access is unavailable. Never request, store, or print credentials.
4. Confirm that the destination is absent or empty and that `gh repo view "OWNER/REPO"` establishes the target repository does not exist.

## Create and publish

1. Run `context-tree init --repository "OWNER/REPO" --tree-path "<destination>" --title "<title>" --owner "<owner>"`. The scaffold always contains the packaged GitHub Actions workflow pinned to the installed package version and filtered to `main`.
2. Run `context-tree verify --tree-path "<destination>"` and require a valid result.
3. Run `git init --initial-branch=main`, add only the scaffolded files, inspect the complete staged diff, and commit. Do not rely on `init.defaultBranch` or other user Git configuration.
4. Run `gh repo create "OWNER/REPO" --private --source "<destination>" --remote origin --push`. Create a public repository only when the user explicitly requests it; publish `main` only.
5. Verify that normalized `origin` matches `OWNER/REPO`, the checked-out branch is `main`, the local commit SHA equals `refs/remotes/origin/main`, and `refs/heads/main` exists remotely.

If creation or push has an uncertain result, inspect `gh repo view`, the local
remote, and `git ls-remote` before retrying only the missing operation. Never
delete a GitHub repository or overwrite remote history. Stop if the target
repository already exists or the destination is not absent or empty.
