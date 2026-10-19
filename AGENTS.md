# AGENTS.md

This repository publishes `@first-tree-ai/context-tree`, the portable Context Tree content engine, CLI, and framework-neutral skills.

Distribution is npm only: the package exposes a `bin`, and `postinstall` runs `context-tree skills install` to copy the skills into each host's skill directory. There are no plugin manifests, marketplaces, or lifecycle hooks.

## Boundaries

- Use generic project names in examples and fixtures. Documentation describes current behavior, without historical comparisons or migration commentary.
- Host Git tools own private-repository authentication.
- Zod schemas are the source of truth for public wire contracts.
- `init`, `connect`, `disconnect`, `read`, and `verify` default to human-readable text and print one line of JSON to stdout only with `--json`; their text-mode failures print a sanitized line to stderr. `sync`, `write` subcommands, and `skills` subcommands always print exactly one line of JSON to stdout and nothing to stderr. Skills pass `--json` for structured output.
- Install and uninstall own exactly the `context-tree-` prefix in each host's skills directory; nothing else is ever replaced or removed.
- Use `unknown` plus narrowing; avoid `any`, enums, and unjustified type assertions.
- Keep public functions explicitly typed and use `import type`.
- Preserve path-containment and symlink fail-closed behavior.
- Never accept or log credential-bearing repository URLs.
- Skills contain only reusable agent instructions and required resources, and invoke `context-tree` on `PATH`.
- The editorial policy lives in the skills that need it, not in a separate command or file.
- Never write project instruction files or symlinks. Directory sources leave Git ownership to their host project.

## Commands

```bash
pnpm install
pnpm check
pnpm typecheck
pnpm test
pnpm check:package
```

Run the full command set before publishing. `pnpm test` builds first and runs
every suite; `pnpm check:package` packs the real tarball and asserts its
contents.
