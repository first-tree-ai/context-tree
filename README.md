# Context Tree

`@first-tree-ai/context-tree` is the portable core for a GitHub-backed Context
Tree: durable decisions, constraints, and cross-domain relationships
stored as Markdown in a private GitHub repository. It ships deterministic local
scaffolding, validation, scoped reading, the canonical policy, Zod contracts,
and framework-neutral agent skills.

The core and CLI never make network requests or manage credentials. Init takes
an explicit GitHub `OWNER/REPO`. Read and write instead take an existing local
checkout whose exact path authorizes only that checkout and its verified,
credential-free GitHub `origin`. GitHub Enterprise Server and other forges are
unsupported.

## Install

```bash
pnpm add @first-tree-ai/context-tree
pnpm exec context-tree --help
```

Or install the CLI globally:

```bash
npm install --global @first-tree-ai/context-tree
```

Bundled skills can be installed with the Agent Skills CLI:

```bash
npx skills add first-tree-ai/context-tree --list
npx skills add first-tree-ai/context-tree --skill context-tree-read
```

## CLI

The CLI exposes exactly four commands: `init`, `policy`, `read`, and `verify`.
Successful command results and runtime or argument failures emit one versioned
JSON object on stdout. Help and version output remain plain text.

```bash
context-tree init \
  --repository acme/context \
  --tree-path ./context-tree
context-tree policy
context-tree verify --tree-path ./context-tree
context-tree read --tree-path ./context-tree --content
```

When `--tree-path` is omitted, init writes to `./REPO` and uses the `REPO`
segment verbatim as the tree title. Scaffolding is create-only and always
includes GitHub Actions validation pinned to the package version that created
the tree and filtered to the branch selected by ordinary `git init`. Init
requires Git and respects Git's effective `init.defaultBranch` configuration or
its compiled fallback. The CLI and library perform no GitHub or credential
operations. The init skill uses the CLI-created repository and current branch
for its local commit and, when GitHub CLI is authenticated, private-repository
publication and default-branch configuration.

Reads default to normal content. Select member, archive-supporting, or all
classes only when needed. The read skill fast-forward refreshes an explicitly
supplied existing checkout, requires it to be clean and on the expected branch,
derives `OWNER/REPO` from its safe GitHub origin, and reports the exact Git
commit SHA. If GitHub is unavailable, a stale read requires explicit
authorization and is clearly labeled; stale state can never become the base for
a write.

Writes are normal file edits performed by the write skill, not a CLI command.
Every write receives one concrete source through the authorized task context,
accepts an authoritative `default_branch`, freshly fetches that branch through
a supplied fetch-only checkout, creates an isolated worktree at its exact
commit, verifies the base, edits only necessary Markdown, verifies again,
inspects the complete diff, commits, and non-force pushes directly to the
supplied default branch. Concurrent updates are rebased and verified locally
with bounded retries. If direct publication is denied or the retry limit is
exhausted, the skill rebases against the latest default branch and opens a
conflict-free fallback PR without merging it or requesting reviewers. An
invalid base blocks semantic changes; an explicit repair request may produce a
repair-only write and commit limited to validator findings. Each write and
commit is scoped to one concrete source. Read and write use `agent_slug` solely
to select optional private memory at `members/<agent_slug>/memory.md`.

## Library integration

```ts
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "@first-tree-ai/context-tree";
import { contextTreeReadResultSchema, verifyTreeReportSchema } from "@first-tree-ai/context-tree/schemas";

scaffoldTree({
  path: "./context-tree",
  repository: "acme/context",
});
const verification = verifyTree("./context-tree");
const relevant = readTree("./context-tree", { path: "systems", content: true });

verifyTreeReportSchema.parse(verification);
contextTreeReadResultSchema.parse(relevant);
```

Git commit SHAs identify shared snapshots. Read entries, read results,
verification reports, and policy results intentionally contain no hashes or
digest fields. See [the format specification](docs/specification.md).
