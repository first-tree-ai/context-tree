---
name: context-tree-init
description: Create a local Context Tree and, when GitHub CLI is authenticated, publish it as a new private GitHub repository.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.2"
---

# Context Tree Init

Use this skill only to create a new Context Tree; never update an existing tree.
Support only `github.com`, not GitHub Enterprise Server or other forges. The
Context Tree CLI scaffolds the local files and Git repository; this skill owns
the local commit and optional GitHub operations.

## Invocation inputs

- `repository`: canonical `OWNER/REPO`
- `tree_path`: optional absent or empty destination; default to `./REPO`

## Resolve inputs and publication mode

1. Use a canonical `OWNER/REPO` already supplied by the user or available from unambiguous authoritative task context. If it is missing, partial, inferred, or conflicts with another authoritative value, ask the user; never invent, combine, or replace it. Reject repository URLs so credentials cannot enter commands or logs.
2. If `tree_path` is omitted, use `./REPO`. Require the resolved destination to be absent or empty and preserve path-containment and symlink fail-closed behavior.
3. Run `context-tree --version`. If it is missing, stop and tell the user to run `npm install --global @first-tree-ai/context-tree`; never install it automatically. Git is also required because `context-tree init` creates the repository using ordinary `git init` and Git's effective default-branch configuration.
4. Detect `gh` with `command -v gh`. If present, run `gh auth status --hostname github.com` without printing credentials or auth output. A definitely missing command or definitely unauthenticated `github.com` session selects local-only mode. A network, API, permission, or ambiguous auth-status failure is an error; never reinterpret an operational failure as local-only mode.
5. In authenticated mode, before writing local files, query the exact `OWNER/REPO` with `gh api "repos/OWNER/REPO"`. If it exists, stop clearly. Proceed only when GitHub gives a definite not-found response. Treat network, API, and permission failures as errors rather than falling back to local-only creation.

## Scaffold and commit

1. Run `context-tree init --repository "OWNER/REPO" --tree-path "<tree_path>"` and treat its JSON scaffold result as authoritative. Parse the complete result, require it to match the scaffold result contract, and require `verification.ok === true`. If the result is malformed, does not match the contract, or contains a failed verification, stop before staging or publishing and preserve the generated repository for inspection.
2. Treat the Git repository created by the CLI as authoritative. Resolve its current unborn branch with `git -C "<tree_path>" symbolic-ref --short HEAD`, preserve the returned spelling exactly as `current_branch`, and do not run `git init` or replace the branch.
3. In that repository, stage only `NODE.md` and `.github/workflows/validate-context-tree.yml`. Inspect `git status --short` and the complete staged diff, confirm no other path is staged, then commit locally on `current_branch`. If any Git operation fails, stop and preserve the local files and repository for inspection.

## Finish the selected mode

- Local-only: stop after the verified local commit. Report its path and SHA and state explicitly that no GitHub repository or remote was created.
- Authenticated GitHub: run `gh repo create "OWNER/REPO" --private --source "<tree_path>" --remote origin --push` and publish only `current_branch`. Verify that normalized `origin` matches `OWNER/REPO`, the checked-out branch is exactly `current_branch`, the local commit SHA equals `refs/remotes/origin/<current_branch>`, and `refs/heads/<current_branch>` exists remotely.
- After the push is verified, explicitly run `gh repo edit "OWNER/REPO" --default-branch "<current_branch>"`, then run `gh repo view "OWNER/REPO" --json defaultBranchRef --jq '.defaultBranchRef.name'` and require the exact current branch value. If mutation or verification fails, do not undo or repeat creation or push: preserve the published repository and local state, and report that creation and publication succeeded but default-branch configuration failed or remains unverified.

Use the host's existing `git` and `gh` setup directly. If an attempted operation
fails, never request, store, or print credentials.

If creation or push has an uncertain result, inspect `gh repo view`, the local
remote, and `git ls-remote` for `refs/heads/<current_branch>` before retrying only the missing operation. Never
delete a GitHub repository or overwrite remote history. If another actor creates
`OWNER/REPO` between preflight and creation, report the collision and preserve
the local commit without retrying destructively or adopting the repository.
