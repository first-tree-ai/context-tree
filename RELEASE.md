# Release

`@first-tree-ai/context-tree` publishes from `.github/workflows/ci.yml` using
npm trusted publishing. npm is both the plugin artifact channel used by the
Codex and Claude Code marketplaces and the optional global CLI distribution
channel. Authentication is short-lived OIDC exchanged at publish time; the
repository holds no npm token and no publish secret.

Two channels exist:

| Channel | Trigger | Version | dist-tag |
| --- | --- | --- | --- |
| Staging | Push to `main` | `<patch+1>-alpha.<UTC YYYYMMDDHHmm>` | `staging` |
| Production | Push a version tag | Exactly the tag | `latest` |

```bash
npm install @first-tree-ai/context-tree            # production
npm install @first-tree-ai/context-tree@staging    # newest build of main
```

Both channels run behind the `test` job. A red CI run publishes nothing.

## Local plugin testing

Marketplace installation from the repository requires repository access. For
local development, test the actual packed working tree in an isolated Codex
configuration instead of the npm `latest` package:

```bash
pnpm test:codex-plugin
```

This opens Codex in a temporary unconnected project. Use
`pnpm test:codex-plugin --check` for a non-interactive installation and hook
discovery smoke test. Both modes remove their temporary marketplace, plugin
cache, Codex home, and project when they finish.

Before advertising or releasing the remote marketplace flow, verify that npm
`latest` contains the `.codex-plugin` and `.claude-plugin` current-client
adapters, both marketplaces, `hooks`, all six `skills` and their launchers, and
`dist/cli/index.mjs`. It must not contain a root `plugin.json`, which
suppresses bundled-hook discovery in Codex 0.151.0. The package
end-to-end test and `npm pack --dry-run` cover the candidate tarball; checking
`latest` is a release verification step after production publication.

## Staging releases

Every push to `main` publishes automatically. Nothing to do by hand.

The version is the current `package.json` version with the patch incremented,
followed by `-alpha.` and a UTC minute-resolution build number. `0.1.0` becomes
`0.1.1-alpha.202608200654`.

The patch is bumped *before* the prerelease suffix is attached because SemVer
ranks `0.1.0-alpha.N` below `0.1.0`. Naming a staging build after the current
base would publish something that sorts older than the last production release,
and `@staging` would resolve backwards.

To publish a staging build without a new commit, run the `CI` workflow manually
from the Actions tab (`workflow_dispatch` on `main`).

## Production releases

1. Bump `version` in `package.json` and propagate it to the skills:

   ```bash
   npm version <X.Y.Z> --no-git-tag-version
   node scripts/sync-skill-versions.mjs
   ```

2. Run the full pre-publish set from `AGENTS.md`:

   ```bash
   pnpm install
   pnpm check
   pnpm typecheck
   pnpm test
   pnpm build
   pnpm validate:skills
   pnpm check:package
   npm pack --dry-run
   pnpm test:codex-plugin --check
   ```

3. Merge to `main`, then tag that commit and push the tag:

   ```bash
   git tag -a v<X.Y.Z> -m "v<X.Y.Z>"
   git push origin v<X.Y.Z>
   ```

Pushing the tag triggers the production publish. Step 1 is not strictly
required — the tag is the source of truth and CI rewrites `package.json` to
match, logging a notice when they differ — but skipping it strands `main` on a
lower version and makes the next staging build sort below the release you just
shipped. Keep `main` at or ahead of the newest tag.

### Accepted tags

`v0.1.1` and `0.1.1` both publish `0.1.1`; the leading `v` is stripped. A tag
that is not `X.Y.Z` with an optional prerelease suffix fails the job before
anything is published.

A prerelease tag publishes under its own identifier and never touches `latest`:

| Tag | Version | dist-tag |
| --- | --- | --- |
| `v0.2.0` | `0.2.0` | `latest` |
| `v0.2.0-beta.1` | `0.2.0-beta.1` | `beta` |
| `v0.2.0-rc.1` | `0.2.0-rc.1` | `rc` |
| `v0.2.0-1` | `0.2.0-1` | `next` |

Only a clean `X.Y.Z` tag moves the stable channel.

## Version bookkeeping

The package version is declared in `package.json`, the `metadata.version`
frontmatter of every `skills/*/SKILL.md`, and both current-client adapter
manifests.
The skill and plugin package-contract tests assert they match, and `prepack`
runs those tests on every publish, so version drift fails the release.

`scripts/sync-skill-versions.mjs` copies `package.json`'s version into each
skill and both plugin manifests. It is idempotent and takes `--check` to
report drift without writing:

```bash
node scripts/sync-skill-versions.mjs           # fix
node scripts/sync-skill-versions.mjs --check   # verify
```

CI runs it on the runner after rewriting the version. That rewrite is never
committed back to the repository — releases do not push to `main`.

## What CI does not do

- It does not commit the version bump back to `main`.
- It does not create a GitHub Release or changelog.
- It does not publish provenance (see below).

## Trusted publisher configuration

Configured once on npmjs.com under the package's settings. npm allows exactly
one trusted publisher per package and matches it on the workflow filename,
which is why staging and production both live in `ci.yml` rather than in
separate workflows.

| Field | Value |
| --- | --- |
| Publisher | GitHub Actions |
| Organization or user | `first-tree-ai` |
| Repository | `context-tree` |
| Workflow filename | `ci.yml` |
| Environment name | *(empty)* |

All fields are case-sensitive. Setting an environment name here also requires
adding `environment:` to both publish jobs.

Publishing requires npm 11.5.1 or later; the jobs install it explicitly because
Node 22 ships npm 10.

## Provenance

Trusted publishing enables provenance by default, but sigstore rejects
attestations whose source repository is private, so both jobs pass
`--provenance=false`. `first-tree-ai/context-tree` is private; if it becomes
public, drop that flag to get signed provenance and a public transparency-log
entry for every release.

## Troubleshooting

**`already published; skipping`** — a warning, not a failure. Both jobs check
the registry first and skip when the version exists, so re-running a workflow
is safe and stays green. Two merges landing inside the same UTC minute produce
the same staging version; the second skips and the next push publishes
normally.

**`Tag '<name>' is not a semver release tag`** — the tag is not `X.Y.Z` or
`vX.Y.Z`. Delete it, re-tag correctly, and push again. Nothing was published.

**`E422 ... Unsupported GitHub Actions source repository visibility: "private"`**
— provenance was enabled against a private repository. See above; both publish
commands must keep `--provenance=false`.

**`Unable to authenticate` / OIDC failure** — the trusted publisher fields do
not match this repository or workflow filename, or the job is missing
`id-token: write`. Compare against the table above; the match is exact and
case-sensitive.

**Publish fails inside `prepack`** — `npm publish` re-runs
`pnpm build && pnpm validate:skills`. A skills assertion failure here almost
always means the skill frontmatter version drifted from `package.json`; run
`node scripts/sync-skill-versions.mjs`.

**A version is permanently unavailable** — npm never lets an unpublished
version number be reused. Choose the next version rather than trying to
republish.
