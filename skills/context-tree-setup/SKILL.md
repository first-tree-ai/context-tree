---
name: context-tree-setup
description: Offer optional Context Tree setup when requested or after a read/write reports NO_CONNECTION. Connect an existing tree or create a local or private GitHub tree, then return to the pending operation; respect session opt-outs.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Setup

## When To Offer Setup

Use setup when requested or after a read/write reports `NO_CONNECTION`; an
installed skill alone is not a reason to interrupt the user's task. Honor any
choice already made in this conversation, including a target, local-only use,
or permission to create a private GitHub repository. Ask only for missing
information, not confirmation of the same choice again.

If the user declines Context Tree use or says "not this session", return a
skipped outcome and continue the original task without Context Tree. Remember
that preference in the conversation for this project for the rest of the
session: do not retry reads/writes or offer setup again unless the user reopens
it. An unanswered automatic setup offer is also deferred for this session until
the user resumes it; a later read/write is not a reason to ask again.
Do not persist this preference in project files or disconnect an existing
tree. If nobody can answer a setup question, defer the Context Tree operation;
do not assume consent or keep asking.

## Resolve And Choose

Keep the original project's stable absolute path throughout setup and any
resumed operation. Pass it as `--project-path "<project>"` to project commands,
including delegated create/connect/publish operations; do not substitute a
Context Tree checkout or temporary worktree as the project.

If `context-tree` is not found, report once that installation requires
`npm install --global @first-tree-ai/context-tree` and defer setup. Continue the
original task where possible; do not install automatically.

Run `context-tree resolve --project-path "<project>" --json`. If it succeeds,
return the existing connection as ready, with its kind and canonical path.
Do not offer to replace it; an explicit request to switch belongs to
`$context-tree-connect`.

On `NO_CONNECTION`, use an already specified choice directly. Otherwise ask
whether to use an existing tree, create a new one, or skip Context Tree for
this session. Make the storage choices clear:

- **Existing tree:** run `context-tree list --json` when the user needs target
  discovery. Offer the listed managed names with their local/GitHub kind, a
  GitHub `OWNER/REPO`, or an exact local checkout path. A checkout on disk may
  itself be GitHub-backed. Pass the chosen target to `$context-tree-connect`.
- **New tree:** ask whether to keep it local or create a private GitHub
  repository, unless that preference was already supplied. Delegate to
  `$context-tree-create` with that choice. Creating a new GitHub tree starts
  locally and then invokes `$context-tree-publish`; choosing that option
  authorizes publication without another approval question.
- **Skip this session:** return skipped and resume the original task without
  Context Tree. Do not propose a local tree as a fallback after the user declines.

## Return To The Caller

Setup is complete when the requested create/connect workflow succeeds, including
publication if requested. Return a clear ready, skipped, or failed outcome in
prose; these are workflow outcomes, not new CLI schemas. When ready, the calling
read/write resumes its pending operation once for the same project. When skipped
or failed, it does not retry or claim that context was read or saved. A direct
setup request simply reports its outcome.

Any error other than `NO_CONNECTION`, or an error in create/connect/publish,
ends this setup attempt. Report it without automatic repair, replacement,
credential changes, or a fallback tree. If publication fails after local
creation, report the remaining local connection and any uncertain remote state;
do not silently treat the requested GitHub setup as complete.
