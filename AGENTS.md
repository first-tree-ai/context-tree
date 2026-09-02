# AGENTS.md

This repository publishes `@first-tree-ai/context-tree`, the portable Context Tree core, CLI, templates, and framework-neutral skills.

Distribution is npm only: the package exposes a `bin`, and `postinstall` runs `context-tree install` to copy the skills into each host's skill directory. There are no plugin manifests, marketplaces, or lifecycle hooks.

## Boundaries

- Host Git and GitHub CLI tools own private-repository authentication.
- Zod schemas are the source of truth for public wire contracts.
- `create`, `connect`, `list`, `resolve`, `publish`, `read`, and `verify` default to human-readable text and print one line of JSON to stdout only with `--json`; their text-mode failures print a sanitized line to stderr. `sync`, `prepare-write`, `finish-write`, and `install` always print exactly one line of JSON to stdout and nothing to stderr. Skills pass `--json` so their parsing is unchanged.
- Use `unknown` plus narrowing; avoid `any`, enums, and unjustified type assertions.
- Keep public functions explicitly typed and use `import type`.
- Preserve path-containment and symlink fail-closed behavior.
- Never accept or log credential-bearing repository URLs.
- Skills contain only reusable agent instructions and required resources, and invoke `context-tree` on `PATH`.
- The editorial policy lives in the skills that need it, not in a separate command or file.
- Writes into a user's own project are limited to the marker-delimited `AGENTS.md` pointer.

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
