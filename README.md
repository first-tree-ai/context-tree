# Context Tree

`@first-tree-ai/context-tree` is the portable, local-first implementation of Context Tree: a Git-native format for durable decisions, constraints, ownership, and cross-domain relationships.

It ships:

- a reusable TypeScript API;
- the `context-tree` CLI;
- structural verification and mechanical audit evidence;
- guarded local write plans;
- read, write, and audit agent skills;
- the canonical policy and scaffold templates.

It does not require a First Tree account and does not contain First Tree Team authorization, Cloud bindings, chat, telemetry, or reviewer dispatch.

## Install

```bash
pnpm add @first-tree-ai/context-tree
pnpm exec context-tree --help
```

For a global command:

```bash
npm install --global @first-tree-ai/context-tree
context-tree --help
```

Node.js 22.13 or newer is required.

## Quick start

```bash
context-tree init --tree-path ./context-tree --title "Acme" --owner alice
context-tree policy
context-tree verify --tree-path ./context-tree
context-tree read --tree-path ./context-tree --content
context-tree audit --tree-path ./context-tree --json
```

The CLI is deliberately local-only. It never clones, fetches, pulls, pushes, opens a PR, or manages credentials.

## Private repositories

Clone or fetch a private tree with ordinary host Git authentication, then point the CLI at the checkout:

```bash
git clone git@github.com:acme/context-tree.git
context-tree verify --tree-path ./context-tree
```

HTTPS uses the configured Git credential helper. SSH uses the configured SSH agent, keys, and `~/.ssh/config`. Agent-run network operations should set `GIT_TERMINAL_PROMPT=0` so missing access fails rather than opening a prompt.

Never put tokens in repository URLs, write plans, tree content, or logs. Forge API authentication through `gh` or `glab` is separate from Git transport authentication.

## Guarded writes

`context-tree write` accepts an explicit JSON plan:

```json
{
  "schemaVersion": 1,
  "expectedTreeDigest": "<digest from read or audit>",
  "operations": [
    {
      "op": "replace",
      "path": "systems/runtime.md",
      "expectedSha256": "<file digest from read>",
      "content": "---\ntitle: \"Runtime\"\nowners: [alice]\n---\n\n# Runtime\n"
    }
  ]
}
```

Dry-run first:

```bash
context-tree write --tree-path ./context-tree --plan ./plan.json --dry-run
context-tree write --tree-path ./context-tree --plan ./plan.json
```

The complete prospective tree must verify before live files change. The command performs no Git commit or remote operation.

## Library

```ts
import { auditTree, readContextTreePolicy, readTree, verifyTree } from "@first-tree-ai/context-tree";

const policy = readContextTreePolicy();
const verification = verifyTree("./context-tree");
const relevant = readTree("./context-tree", { path: "systems", content: true });
const evidence = auditTree("./context-tree");
```

See [the format specification](docs/specification.md) and [integration guide](docs/integration.md).
