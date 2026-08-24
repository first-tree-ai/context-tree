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
  --tree-path ./context-tree \
  --title "Acme"
context-tree policy
context-tree verify --tree-path ./context-tree
context-tree read --tree-path ./context-tree --content
```

Scaffolding is create-only and always includes GitHub Actions validation pinned
to the package version that created the tree. New repositories always start on
`main`, independently of the user's Git configuration. The init skill verifies,
commits, creates a private GitHub repository, and pushes `main`.

Reads default to normal content. Select member, archive-supporting, or all
classes only when needed. The read skill fast-forward refreshes an explicitly
supplied existing checkout, requires it to be clean and on the expected branch,
derives `OWNER/REPO` from its safe GitHub origin, and reports the exact Git
commit SHA. If GitHub is unavailable, a stale read requires explicit
authorization and is clearly labeled; stale state can never become the base for
a write.

Writes are normal file edits performed by the write skill, not a CLI command.
Every write receives one concrete source through the authorized task context,
freshly fetches the explicit base branch through a supplied fetch-only checkout,
creates an isolated worktree at its exact commit, verifies the base, edits only
necessary Markdown, verifies again, inspects the complete diff, commits,
non-force pushes, and opens a GitHub PR. The skill never merges. An invalid base
blocks semantic changes; an explicit repair request may produce a repair-only
PR limited to validator findings. Read and write use `agent-slug` solely to
select optional private memory at `members/<agent-slug>/memory.md`.

## Library integration

```ts
import { readContextTreePolicy, readTree, scaffoldTree, verifyTree } from "@first-tree-ai/context-tree";
import { contextTreeReadResultSchema, verifyTreeReportSchema } from "@first-tree-ai/context-tree/schemas";

scaffoldTree({
  path: "./context-tree",
  repository: "acme/context",
  title: "Acme",
});
const verification = verifyTree("./context-tree");
const relevant = readTree("./context-tree", { path: "systems", content: true });

verifyTreeReportSchema.parse(verification);
contextTreeReadResultSchema.parse(relevant);
```

Git commit SHAs identify shared snapshots. Read entries, read results,
verification reports, and policy results intentionally contain no hashes or
digest fields. See [the format specification](docs/specification.md).
