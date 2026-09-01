---
name: context-tree-publish
description: Publish the current project's local Context Tree as a new private GitHub repository. Use only when the user explicitly asks to publish or share the tree.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
  version: "0.1.6"
---

# Context Tree Publish

Resolve `<skill-directory>` to this skill's directory and run
`node "<skill-directory>/scripts/context-tree.mjs" --version` once per session.
If the packaged CLI is unavailable, stop and ask the user to reinstall or
update the plugin.

Run `node "<skill-directory>/scripts/context-tree.mjs" publish`. When the user
explicitly supplies an alternative, append the validated `OWNER/REPO` argument.
Never accept a repository URL.

Publication creates one new private repository, and the local connection update
that follows is not part of the same atomic step. If it reports
`PUBLISH_INCOMPLETE`, do not inspect, adopt, repair, retry, or delete partial
state; report the uncertain outcome. If it reports `INVALID_TREE`, run `verify`
and report its findings.
