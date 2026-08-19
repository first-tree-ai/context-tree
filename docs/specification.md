# Context Tree Format Specification

## Root

A Context Tree is a real filesystem directory containing a required `NODE.md`. A root `SCOPE.md` is optional but, when present, must be a regular UTF-8 file with schema-version-1 YAML frontmatter and a non-empty prose body.

```yaml
---
schemaVersion: 1
relatedRepositories:
  - https://github.com/acme/service.git
---
```

Related repository references must be credential-free HTTPS or SSH identities.

## Nodes

Every normal or archive-supporting directory requires a `NODE.md`. Every normal node is either:

- a directory represented by its `NODE.md`; or
- a Markdown leaf beside or beneath a directory node.

Normal nodes require:

```yaml
---
title: "Short noun phrase"
owners: [alice]
---
```

`description` is an optional non-empty string. `soft_links` is an optional non-empty string array containing tree-root-relative Markdown files or node directories.

## Content classes

- `normal`: root and domain decisions.
- `archive-supporting`: material beneath `raw-context/`.
- `member`: material beneath `members/`.
- `repo-infra`: dot paths, generated output, agent instruction files, and build or CI configuration.

Normal content must not depend on archive/supporting content. Symlinks may not escape the tree, cross content-class boundaries, or represent domain directories.

## Members

`members/NODE.md` is the member index. Each direct member directory requires a `NODE.md` with a non-empty title, owners, type (`human` or `agent`), role, and domains.

## Versioning

Public CLI JSON uses `schemaVersion: 1`. Additive fields may be introduced within version 1. Removing fields, changing meanings, or accepting incompatible tree shapes requires a new schema version and migration guidance.
