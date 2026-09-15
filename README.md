# Context Tree

Context Tree gives coding agents lasting project memory: decisions, constraints,
and the reasons behind them. Use it to avoid repeating context in new sessions,
keep different agents aligned, or share knowledge across related repositories.
Context lives in a separate Git repository. Keep it local or share it through
private GitHub storage.

## Install

Requires **Node.js 22.13+** and **Git**. For GitHub sharing, also install and
sign in to the GitHub CLI (`gh auth login`).

```bash
npm install --global @first-tree-ai/context-tree
```

This installs the CLI and skills for installed **Codex, Claude Code, and Pi**
agents. Restart your agent to discover the skills.

## Get started

Open your project in your agent and ask:

> Set up a local Context Tree for this project, then read the relevant context.

You can also ask to connect an existing tree or create a private GitHub tree.
To create a local tree yourself, run this from your project directory:

```bash
context-tree create
```

The tree is saved under `~/.context-tree/trees` and connected to your project.

## Read and save context

Ask your agent to use the tree as you work:

> Read the Context Tree before planning this change.

> Save our decision to use a single writer, including why we rejected multiple writers.

The read skill retrieves relevant context; the write skill updates it and commits
changes, pushing them when the tree is shared on GitHub. Save decisions and
constraints that future work should respect, with their rationale.

To invoke a skill explicitly, use `$context-tree-read` in Codex,
`/context-tree-read` in Claude Code, or `/skill:context-tree-read` in Pi.
Replace `read` with `write`, `setup`, `create`, `connect`, `publish`, `cleanup`,
or `schedule-cleanup` for the other workflows.

## Share or connect an existing tree

Publish your local tree as a **new private GitHub repository**:

```bash
context-tree publish OWNER/REPO
```

From another project or machine, connect to it:

```bash
context-tree connect OWNER/REPO
```

You can also reuse a local tree by name or connect a checkout on disk:

```bash
context-tree list
context-tree connect my-project-context-tree
context-tree connect --tree-path /absolute/path/to/tree
```

Connecting switches the current project's tree. Run these commands from the
project directory, or add `--project-path /path/to/project`.

Stop using a tree without deleting it or its memory:

```bash
context-tree disconnect
```

## Cleanup and scheduling

Ask your agent to remove outdated clutter and consolidate duplicate context:

> Run the context-tree-cleanup skill for this project and publish the changes.

For recurring cleanup, use the schedule-cleanup skill or run:

```bash
context-tree cleanup schedule --agent codex --every 2h
context-tree cleanup status
context-tree cleanup logs
context-tree cleanup remove
```

Choose `codex`, `claude`, or `pi`; the agent CLI must be installed and authenticated.
Schedules run locally on macOS or Linux while the machine is awake, and skip trees
unused for 24 hours. Use one designated cleaner per shared tree.
`context-tree cleanup run` runs the configured cleanup now; `cleanup logs --list`
lists previous runs.

## Useful commands

```bash
context-tree resolve                              # show this project's tree
context-tree read --tree-path /path/to/tree        # browse its root index
context-tree verify --tree-path /path/to/tree      # check its structure
context-tree disconnect                           # remove this project's connection
context-tree install                              # add skills for a new agent
context-tree install --project .                  # install skills for this project
context-tree uninstall                            # remove Context Tree skills
context-tree --help
```

For scripts and custom integrations, see the [CLI specification](docs/specification.md),
including synchronization, prepared writes, and JSON output.

## Working with OpenTag

Each OpenTag Agent selects its own tree in **Agent settings → Context Tree**.
Enter a GitHub `OWNER/REPO` to connect an existing tree, create a new private
repository from the same panel, or disconnect to leave memory off. OpenTag
connects every visible and internal session for that Agent to the selection.
For a GitHub tree, GitHub authentication must work on the Agent's Computer.

The former `opentag context-tree connect` command is retired and now points to
Agent settings. Existing trees, connections, and memory are preserved; after
upgrading OpenTag, select the repository again for each Agent.

Use the same read, write, and cleanup prompts in OpenTag sessions.
