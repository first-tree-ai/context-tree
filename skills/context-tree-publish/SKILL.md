---
name: context-tree-publish
description: Publish a project's local Context Tree as a new private GitHub repository when the user chooses GitHub publication. Connecting an existing GitHub tree uses connect; local creation does not require publication.
license: Apache-2.0
compatibility: Requires Node.js 22.13+ and the context-tree CLI JSON schema version 1.
metadata:
  author: first-tree-ai
---

# Context Tree Publish

If `context-tree` is not found, stop and ask the user to run
`npm install --global @first-tree-ai/context-tree`.

Use the original project's stable absolute path. An explicit request to publish,
including choosing a new private GitHub tree during setup, authorizes this step;
do not ask again. A vague request to "share" does not choose GitHub or authorize
creating a repository: clarify the intended destination first.

Run `context-tree publish --project-path "<project>" --json`. When the user
explicitly supplies an alternative, append the validated `OWNER/REPO` argument. Never accept a repository URL.

Publication creates one new private repository, and the local connection update
that follows is not part of the same atomic step. If it reports
`PUBLISH_INCOMPLETE`, do not inspect, adopt, repair, retry, or delete partial
state; report the uncertain outcome. If it reports `INVALID_TREE`, run
`context-tree verify --tree-path "<tree-path>" --json` and report its findings.

Return success or failure to create/setup so the pending operation resumes only
after the requested publication succeeds.
