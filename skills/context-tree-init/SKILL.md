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
Context Tree CLI scaffolds the local files and Git repository, configures its
credential-free origin, and links the current project when its identity is
unambiguous. This skill owns the local commit and optional GitHub operations.

## Invocation inputs

- `repository`: canonical `OWNER/REPO`
- `tree_path`: optional absent or empty destination; default to `./REPO`

## Resolve inputs and publication mode

1. Use a canonical `OWNER/REPO` already supplied by the user or available from unambiguous authoritative task context. If it is missing, partial, inferred, or conflicts with another authoritative value, ask the user; never invent, combine, or replace it. Reject repository URLs so credentials cannot enter commands or logs.
2. If `tree_path` is omitted, use `./REPO`. Require the resolved destination to be absent or empty and preserve path-containment and symlink fail-closed behavior. Init records an unambiguous current project identity only in the machine-local links file; it never embeds the source-project association in the Context Tree.
3. Resolve `<skill-directory>` to the plugin skill directory containing this `SKILL.md`, not the project working directory. Run every Context Tree CLI command through the package-relative `scripts/context-tree.mjs` launcher shown below. The launcher requires the private CLI bundled in the same plugin package and never uses a command from `PATH`. First run `node "<skill-directory>/scripts/context-tree.mjs" --version`. If it reports that the packaged CLI is unavailable, stop and tell the user to reinstall or update the Context Tree plugin; never install a package automatically. Git is also required because `node "<skill-directory>/scripts/context-tree.mjs" init` creates the repository using ordinary `git init` and Git's effective default-branch configuration.
4. Detect `gh` with `command -v gh`. If present, run `gh auth status --hostname github.com` without printing credentials or auth output. A definitely missing command or definitely unauthenticated `github.com` session selects local-only mode. A network, API, permission, or ambiguous auth-status failure is an error; never reinterpret an operational failure as local-only mode.
5. In authenticated mode, before writing local files, query the exact `OWNER/REPO` with `gh api "repos/OWNER/REPO"`. If it exists, stop clearly. Proceed only when GitHub gives a definite not-found response. Treat network, API, and permission failures as errors rather than falling back to local-only creation.

## Scaffold and commit

1. Run `node "<skill-directory>/scripts/context-tree.mjs" init --repository "OWNER/REPO" --tree-path "<tree_path>"` from the project directory and treat its JSON scaffold result as authoritative. Parse the complete result, require it to match the scaffold result contract, and require `verification.ok === true`. If the result is malformed, does not match the contract, or contains a failed verification, stop before staging or publishing and preserve the generated repository for inspection. Require the tree's normalized `origin` to match `OWNER/REPO` and require root `NODE.md` to contain no source-project association.
2. Treat the Git repository and credential-free `origin` created by the CLI as authoritative. Resolve its current unborn branch with `git -C "<tree_path>" symbolic-ref --short HEAD`, preserve the returned spelling exactly as `current_branch`, and do not run `git init`, replace the branch, or replace the remote.
3. In that repository, stage only `NODE.md`, `AGENTS.md`, `CLAUDE.md`, and `.github/workflows/validate-context-tree.yml`. Inspect `git status --short` and the complete staged diff, confirm no other path is staged, then commit locally on `current_branch`. If any Git operation fails, stop and preserve the local files and repository for inspection.

## Finish the selected mode

- Local-only: after the verified local commit, run `node "<skill-directory>/scripts/context-tree.mjs" resolve --project-path "$PWD"` when the project identity was unambiguous. Report its path and SHA, state that the mapping exists only in `~/.context-tree/connections.json`, and state explicitly that no GitHub repository was created; the credential-free origin is configured for later publication.
- Authenticated GitHub: run `gh repo create "OWNER/REPO" --private`, then publish only `current_branch` with `git -C "<tree_path>" push --set-upstream origin "<current_branch>"`. Verify that normalized `origin` matches `OWNER/REPO`, the checked-out branch is exactly `current_branch`, the local commit SHA equals `refs/remotes/origin/<current_branch>`, and `refs/heads/<current_branch>` exists remotely. Then run `node "<skill-directory>/scripts/context-tree.mjs" resolve --project-path "$PWD"` when the project identity was unambiguous.
- After the push is verified, explicitly run `gh repo edit "OWNER/REPO" --default-branch "<current_branch>"`, then run `gh repo view "OWNER/REPO" --json defaultBranchRef --jq '.defaultBranchRef.name'` and require the exact current branch value. If mutation or verification fails, do not undo or repeat creation or push: preserve the published repository and local state, and report that creation and publication succeeded but default-branch configuration failed or remains unverified.

Use the host's existing `git` and `gh` setup directly. If an attempted operation
fails, never request, store, or print credentials.

If creation or push has an uncertain result, inspect `gh repo view`, the local
remote, and `git ls-remote` for `refs/heads/<current_branch>` before retrying only the missing operation. Never
delete a GitHub repository or overwrite remote history. If another actor creates
`OWNER/REPO` between preflight and creation, report the collision and preserve
the local commit without retrying destructively or adopting the repository.
