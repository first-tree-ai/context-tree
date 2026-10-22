---
name: context-tree-schedule-cleanup
description: Create, inspect, update, or remove a persistent local host schedule for Context Tree cleanup. Use when the user asks for recurring cleanup or changes its cadence.
---

# Context Tree Schedule Cleanup

Inspect `context-tree cleanup status --tree <name-or-source> --json` first. Reuse the requested connection and host agent (`codex`, `claude`, or `pi`); inspect local availability instead of inventing a model or executable. A schedule requires a committed Git repository.

Create or update with `context-tree cleanup schedule --tree <name-or-source> --agent <agent> --every 2h --json`. Include `--model` only for an explicitly selected model. Include `--publish` only when recurring pushes to this managed Git source are authorized. Otherwise each substantive cleanup retains a review branch. Directory sources always produce review branches.

The CLI installs a local launchd or systemd user job, prepares isolated sessions, and invokes the packaged editorial rules. Do not create another scheduler. Unchanged tree content is skipped after a successful pass; unrelated code commits do not trigger another cleanup. Source, branch, or schedule changes stop a running pass.

Use `cleanup run --tree <name-or-source> --json` for an explicitly requested immediate run, `cleanup logs --tree <name-or-source> --json` to inspect output, and `cleanup remove --tree <name-or-source> --json` to disable and unregister the job. Report cadence, agent, publication policy, and retained work when relevant.

Invoke `context-tree` on PATH. If missing, install with `npm install --global @first-tree-ai/context-tree`.
