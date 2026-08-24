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

Use this skill only to create a new Context Tree; never update an existing tree.
Require the user to provide a GitHub `OWNER/REPO`, a local destination that is
absent or empty, a tree title, and an initial owner. Always use `main`; do not
accept a configurable branch. Support only `github.com`, not GitHub Enterprise
Server or other forges.

First run `context-tree --version`. If the command is missing, stop and tell the
user to run `npm install --global @first-tree-ai/context-tree`. Never install a
package automatically.

## Invocation inputs

- `repository`: canonical `OWNER/REPO`
- `tree_path`: absent or empty destination
- `title`: tree title
- `owner`: initial human owner

## Create and publish

1. Validate all four inputs. Require canonical `OWNER/REPO`, not a URL, so credentials cannot enter commands or logs. Require `tree_path` to be absent or empty.
2. Run `context-tree policy`, then `context-tree init --repository "OWNER/REPO" --tree-path "<tree_path>" --title "<title>" --owner "<owner>"`.
3. Run `context-tree verify --tree-path "<tree_path>"` and require a valid result.
4. In the explicit destination, run `git init --initial-branch=main`, add only the scaffolded files, inspect the complete staged diff, and commit.
5. Run `gh repo create "OWNER/REPO" --private --source "<tree_path>" --remote origin --push`. Publish `main` only.
6. Verify that normalized `origin` matches `OWNER/REPO`, the checked-out branch is `main`, the local commit SHA equals `refs/remotes/origin/main`, and `refs/heads/main` exists remotely.

Use the host's existing `git` and `gh` setup directly. If an attempted operation
reports that its command is unavailable, unconfigured, unauthenticated, or has
otherwise failed, stop immediately. Never request, store, or print credentials.

If creation or push has an uncertain result, inspect `gh repo view`, the local
remote, and `git ls-remote` before retrying only the missing operation. Never
delete a GitHub repository or overwrite remote history.
