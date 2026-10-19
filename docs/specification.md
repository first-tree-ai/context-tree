# Architecture and contracts

A Context Tree is content rooted at a directory containing `NODE.md`. Its identity does not depend on a Git repository. Git is a source and an optional write mechanism.

## Layers

- `contracts/`: Zod schemas and derived public types. CLI/config version 3 and document version 1 are separate contracts.
- `tree/`: directory content, frontmatter, links, indexed reads, validation, and content-only scaffolding. No Git, project configuration, scheduler, or host integration.
- `sources/`: project-root discovery, source identities, directory resolution, Git caches, and snapshots.
- `operations/`: connection changes, initialization, write sessions, and scheduled cleanup orchestration.
- `adapters/`: Git subprocesses, private machine state, skill installation, package resources, agent execution, history, and native schedulers.
- `cli/`: argument registration and presentation. Commands call operations; skills invoke the CLI on PATH.

The package exports contracts and a CLI. Internal functions are implementation details. There is no plugin protocol or provider abstraction hierarchy.

## Project declarations

`.context-tree.json` contains exactly `schemaVersion: 3` and `trees`, an array of sources. There are no user-assigned aliases. A directory source has `kind: directory` and `path`; a Git source has `kind: git`, `repository` (`owner/repo`), `path`, and `ref` (an explicit branch). Unknown keys and unsupported versions fail validation. Git repository identities are case-normalized. Paths to subtrees are canonical relative paths without parent or `.git` segments; directory sources may also use absolute paths.

Discovery walks toward the Git checkout root and never crosses it. Outside Git it walks toward the filesystem root. With no config, the default project root is the Git checkout root or the supplied directory. Connection mutation uses a lock and atomic replacement. Duplicate source identities are invalid. Connecting an already declared source is idempotent. Disconnect removes only the declaration.

Directory identity is its resolved path. Git identity is repository + subtree + branch. Logical source identity is separate from the current revision. A short selector is the directory basename or repository name. An exact selector is the absolute directory path or `https://github.com/owner/repo/tree/<encoded-branch>/<encoded-subtree>`; the subtree suffix is omitted for `.`. Branch names and subtree segments are URL-encoded separately. Selectors are generated and compared literally, never parsed or stored. Ambiguous selection fails with the matching exact selectors. Write sessions and schedules bind to the full source, so adding a namesake or reordering configuration cannot redirect pending work. Several subtrees and branches share a repository cache while retaining distinct connections and write boundaries.

## Resolution

Directory resolution returns the real content root and, when available, repository root, repository-relative subtree, branch, HEAD, and subtree dirtiness. No repository is required. Reads allow working changes.

Managed Git resolution uses one bare cache per repository and detached snapshots keyed by repository and commit. `sync` fetches the exact declared branch. `sync --offline` requires a cached ref and performs no network access. A snapshot's identity and cleanliness are checked before reuse. Symlinked roots and nested repository ownership are rejected. `sync` validates fetched tree content. The returned snapshot path is stable across later refreshes.

`sync` returns `{ schemaVersion, connections }`. Each entry is either `{ ok: true, connection, treeRoot, repository, dirty }` or `{ ok: false, connection, error }`. Configuration failure fails the whole request; individual source failure preserves successful results.

## Write sessions

Directory content can be edited directly and checked with `verify`; this requires no session or Git repository. The host owns staging and commits for direct edits.

`write prepare` creates an isolated session for either source kind, starting at the resolved committed revision on a unique branch in a separate worktree. The subtree must be clean. A session pins its project connection, content root, and repository state. Session IDs are UUIDs; repository, worktree, and task branch are required.

`write finish` checks connection and repository identity, requires the expected branch and HEAD, rejects every pending path outside the tree, validates content, stages only its subtree, and commits. It rechecks the commit and worktree before reporting success. Ignored untracked content is included in boundary checks and cannot silently disappear from a managed commit.

Completion reports `unchanged`, `committed`, or `published`. A committed session remains available for review or later publication. Publishing is supported only for managed Git sources and requires an explicit flag. It rechecks origin and uses a normal nonforce push to the pinned target branch. No rebasing, retries, merges, or conflict resolution is hidden inside completion. Errors retain work. `write abort` removes empty sessions; sessions containing edits or commits cannot be discarded by the CLI.

## Content

The root `NODE.md` has `schemaVersion: 1`, a nonempty title, and a nonempty body, with a 16 KiB limit. Descendant `NODE.md` and Markdown files have a nonempty title and may have a description and nonempty `soft_links` array. Root-only fields are invalid on descendants. Additional frontmatter fields are preserved.

Reading returns the selected body and metadata plus immediate child summaries. It does not expand soft links or recursively load the tree. Reads reject symlinked documents and directory traversal. Verification recursively checks directory indexes, document metadata, link containment, and soft-link existence. Ordinary Markdown links are checked for containment, not full URL or anchor validity.

Normal shared content and `members/` content are indexed equally but have different editorial authority. Hidden files/directories and known repository infrastructure (defined centrally in `tree/content-class.ts`) are excluded. Content symlinks are unsupported, whether internal, external, or broken. Verification rejects them without reading their targets; indexed reads skip symlink children and reject direct symlink targets. Agents must not follow symlinks when editing.

## Machine state and cleanup

`~/.context-tree/` holds repository caches, snapshots, worktrees, write-session records, and cleanup schedules/history. It holds no project connection registry. State paths reject symlinks; writes use temporary files and atomic replacement. Locks fail closed on contention. After a process crash, inspect retained work and confirm no process owns a lock before manually removing that lock directory. Caches and snapshots have no automatic eviction.

Cleanup composes the same isolated preparation and completion operations. A schedule pins a source and branch and stores its explicit publication policy. One schedule owns a logical source/branch on a machine. It captures executable paths and launches through launchd or systemd user timers. Changed schedule/source/branch state cancels the agent. Cleanup restricts edits to normal and member Markdown content, validates through the normal write flow, and retains failures. Successful input subtree digests prevent unrelated code commits from retriggering cleanup. Logs are bounded and credential-redacted.

Host Git supplies authentication. Repository inputs are identities, never credential-bearing URLs. Installation owns only the `context-tree-` skill prefix and never writes project instruction files. Global installation targets detected hosts; project installation is explicit. All publication is an operation or stored schedule policy, never a side effect of reading or connecting.
