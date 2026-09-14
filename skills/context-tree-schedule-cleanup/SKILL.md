---
name: context-tree-schedule-cleanup
description: Create or update a persistent local host task that runs Context Tree cleanup and publishes changes. Use when the user requests recurring cleanup or changes its cadence.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Schedule Context Tree Cleanup

Scheduling authorizes recurring cleanup across shared content and all member
directories and publication without repeated approval. Scheduling alone never
runs cleanup immediately. Use the installed CLI on PATH; if missing, report
`npm install --global @first-tree-ai/context-tree` and stop.

1. Keep the original project's stable absolute path. If replacing a previously
   created Codex desktop Scheduled task or Claude Desktop routine, cancel that
   desktop task using its existing controls before creating the CLI schedule.
   The CLI cannot discover or cancel old desktop tasks. Do not create a duplicate
   while cancellation is unconfirmed.
2. Select the requested installed agent, or the current host's CLI: `codex`,
   `claude`, or `pi`. Use the requested model if supplied; otherwise keep CLI
   defaults. Use a positive whole-minute cadence such as `30m`, `1h`, or `1d`;
   default to every hour. Do not silently approximate unsupported schedules.
3. Run `context-tree cleanup schedule --project-path "<absolute-project-path>" --agent <codex-claude-or-pi> --every <duration> --json`.
   Add `--model <model>` only for an explicit override. Quote real arguments
   safely. Connection or scheduler errors stop without setup or repair.
4. Read back `context-tree cleanup status --project-path "<absolute-project-path>" --json`.
   Report registration, project, cadence, agent/model, last activity, and latest
   outcome. One schedule per tree is shared across projects and both hosts on
   this machine; repeating schedule updates it without an immediate cleanup.
5. For cancellation run `context-tree cleanup remove --project-path "<absolute-project-path>" --json`.
   This disables future runs and stops the active native scheduled process and
   its children. Repeated removal succeeds. Unfinished worktrees remain; already
   published changes remain published. Publication already underway may have
   completed; report uncertainty without rollback or retries.

`context-tree cleanup run --project-path "<absolute-project-path>" --json` runs
one pass with the saved configuration when explicitly requested. It still checks
activity, unchanged commits, and overlap. Do not run it merely when scheduling.

macOS uses user LaunchAgents; Linux uses systemd user timers/services. No desktop
app, daemon, root installation, or Linux lingering is required. The machine must
be awake and the user scheduler available; timing follows the native scheduler.
Defaults are `gpt-5.6-luna` with low reasoning effort for Codex and
`claude-haiku-4-5` for Claude, using existing CLI authentication. Pi uses its
configured default model. Pi runs ephemeral with extensions disabled; `--model`
may also name a `provider/model`. Do not change credentials, bypass permissions,
silently switch models, or retry publication.

Initial scheduling starts a 24-hour activity window. Successful ordinary create,
connect, sync, read, prepare-write, and finish-write use refreshes activity for
scheduled trees. Background cleanup and status never refresh it. Missing or old
activity skips before network or model work; unchanged successfully cleaned
commits skip the model. Failures preserve worktrees and success checkpoints.
The runner owns preparation, verification, and publication; the fresh agent
only edits using the cleanup skill's shared required editorial resource.

Inspect runner history with `context-tree cleanup logs --project-path <project> --json`.
Use `--list` for newest-first summaries or `--run <run-id>` for a particular run;
these selectors are mutually exclusive. The versioned result includes summaries
and the selected run's labeled runner/stdout/stderr events. Reads are snapshots,
do not refresh activity, and do not query the scheduler. Agent output varies by
CLI. Missing terminal outcomes mean incomplete runs. Outcomes include `runId`
when history was recorded.

History is local, shared across connected projects, and survives schedule removal.
Retention is 50 runs (oldest completed runs are pruned; incomplete entries are
protected), with 5 MiB of serialized output per run and an explicit truncation
flag. Final outcome metadata survives output truncation. Credentials and terminal
controls are sanitized; oversized lines are suppressed. Only runner attempts are
recorded, including inactivity and unchanged skips. Old transcripts and cleanup
performed directly through a host skill are unavailable.
