# Release

`@first-tree-ai/context-tree` publishes from `.github/workflows/ci.yml` using
npm trusted publishing. npm is the single distribution channel: it delivers the
CLI and, through `postinstall`, the six skills. Authentication is short-lived
OIDC exchanged at publish time; the repository holds no npm token and no publish
secret.

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

## Local install testing

`pnpm check:package` packs the real working tree, installs it into a scratch
consumer with scripts enabled, and asserts that a local install writes no
skills, that a global `postinstall` places all six at mode `0644` for a host
that exists while skipping one that does not, and that the repository docs, a
library entry point, and per-skill launcher scripts stay out of the tarball. It
then drives the create/resolve/install/verify/read lifecycle against the
installed CLI and removes everything it created.

This is the only tarball check CI runs. It asserts the packed file list entry by
entry, so a separate `npm pack --dry-run` step would add nothing.

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

1. Bump `version` in `package.json`:

   ```bash
   npm version <X.Y.Z> --no-git-tag-version
   ```

2. Run the full pre-publish command set from `AGENTS.md`.

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

`package.json` is the only place the version is declared. The skills ship in the
same tarball as the CLI that installs them, so there is nothing to keep in sync
and no drift to guard against. CI rewrites `package.json` on the runner; that
rewrite is never committed back — releases do not push to `main`.

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

**Publish fails inside `prepack`** — `npm publish` re-runs `pnpm build`. A
failure here is a build failure; reproduce it locally with `pnpm build`.

**A consumer installed the CLI but has no skills** — they installed locally
rather than with `--global`, or with `--ignore-scripts`, so `postinstall` either
declined to write or never ran. Have them run `context-tree install`.

**A version is permanently unavailable** — npm never lets an unpublished
version number be reused. Choose the next version rather than trying to
republish.
