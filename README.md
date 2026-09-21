# Context Tree

Project memory for coding agents. Save decisions, constraints, and their rationale
in a separate Git repository so your agent can use them in future sessions.
Keep it local or share it through a private GitHub repository.

Works with **Codex, Claude Code, and Pi**.

## Install

Requires **Node.js 22.13+** and **Git**.

```bash
npm install --global @first-tree-ai/context-tree
```

This installs the CLI and skills for your installed agents. Restart your agent
to load the skills.

## Use it

From your project directory:

```bash
context-tree create
```

This creates a local tree under `~/.context-tree/trees` and connects it to your
project. Then ask your agent:

> Read the Context Tree before planning this change.

> Save our decision to use a single writer, including why we rejected multiple writers.

The agent reads relevant context and commits updates. For GitHub trees, it also
pushes changes.

To invoke skills directly, use `$context-tree-read` in Codex,
`/context-tree-read` in Claude Code, or `/skill:context-tree-read` in Pi.
Replace `read` with `write` or `cleanup` to save or tidy context.

## Share a tree

Sign in with `gh auth login`, then publish to a new private GitHub repository:

```bash
context-tree publish OWNER/REPO
```

Connect from another project or machine:

```bash
context-tree connect OWNER/REPO
```

You can also connect a local tree by name or path:

```bash
context-tree list
context-tree connect my-project-context-tree
context-tree connect --tree-path /absolute/path/to/tree
```

A project can use several trees. Name connections with `--as <alias>` and select
one with `--tree <alias>` when writing or publishing.

## Maintain it

Ask your agent to run `context-tree-cleanup`, or schedule regular cleanup:

```bash
context-tree cleanup schedule --agent codex --every 2h
context-tree cleanup status
context-tree cleanup remove
```

Schedules support Codex, Claude Code, and Pi on macOS and Linux. The agent CLI
must be installed and authenticated, and the machine must be awake.

## Other commands

```bash
context-tree resolve                # show this project's connections
context-tree disconnect             # disconnect the sole tree without deleting it
context-tree install                # install skills for a newly added agent
context-tree uninstall              # remove Context Tree skills
context-tree --help
```

In OpenTag, select a tree in **Agent settings → Context Tree**.

See the [CLI specification](docs/specification.md) for command contracts and
integration details.
