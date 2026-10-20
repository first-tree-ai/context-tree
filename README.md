# Context Tree

A shared project notebook for you and your coding agent.

Keep decisions, constraints, and useful lessons in Markdown files alongside your code. Each folder has an index, so an agent can find the context it needs without reading every document.

A tree can live inside an existing repository, in a standalone folder, or in a shared GitHub repository.

## Get started

```sh
npm install --global @first-tree-ai/context-tree
cd my-project
context-tree init docs
```

This creates a tree in `docs/` and connects it to your project.

Read its index:

```sh
context-tree read
```

Edit the Markdown yourself or ask your agent to update it. Check your changes with `context-tree verify`, then commit them with your code.

## Use with your agent

The package includes skills for Claude Code, Codex, and Pi. Global installation adds them for detected hosts; restart your agent to pick them up.

Ask your agent:

> Read the project context before starting. When you're done, record any useful decisions.

You can also ask it to tidy the tree or schedule regular cleanup. Cleanup consolidates duplicates and improves organization, leaving changes on a separate branch for review by default.

## Connect an existing tree

```sh
context-tree connect --path docs
```

To share knowledge across projects, connect a tree from GitHub:

```sh
context-tree connect acme/knowledge --path docs --ref main
```

Use `context-tree sync` to fetch updates. With multiple trees, select one by its directory or repository name, such as `context-tree read --tree knowledge`.

See `context-tree --help` for commands and the [specification](docs/specification.md) for technical details.
