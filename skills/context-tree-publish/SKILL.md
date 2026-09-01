---
name: context-tree-publish
description: Publish the current project's local Context Tree as a new private GitHub repository. Use only when the user explicitly asks to publish or share the tree.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Publish

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Run `context-tree publish`. When the user explicitly supplies an alternative,
append the validated `OWNER/REPO` argument. Never accept a repository URL.

Publication creates one new private repository, and the local connection update
that follows is not part of the same atomic step. If it reports
`PUBLISH_INCOMPLETE`, do not inspect, adopt, repair, retry, or delete partial
state; report the uncertain outcome. If it reports `INVALID_TREE`, run `verify`
and report its findings.
