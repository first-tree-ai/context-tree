# AGENTS.md

This repository publishes `@first-tree-ai/context-tree`, the portable Context Tree core, CLI, policy, templates, and framework-neutral skills.

## Boundaries

- Host Git and GitHub CLI tools own private-repository authentication.
- Zod schemas are the source of truth for public wire contracts.
- Use `unknown` plus narrowing; avoid `any`, enums, and unjustified type assertions.
- Keep public functions explicitly typed and use `import type`.
- Preserve path-containment and symlink fail-closed behavior.
- Never accept or log credential-bearing repository URLs.
- Skills contain only reusable agent instructions and required resources.

## Commands

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm build
pnpm validate:skills
pnpm check:package
npm pack --dry-run
```

Run the full command set before publishing.
