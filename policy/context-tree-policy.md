# Context Tree Policy

## Purpose

A Context Tree stores durable current context: decisions, constraints, ownership, and cross-domain relationships with enough rationale for a future reader to act. It is not a source-code mirror, wiki dump, task queue, or delivery log.

## Source boundary

Record what was decided and why. Keep implementation details, request and response shapes, fixtures, build configuration, one-off fixes, and delivery history in their source systems.

A candidate belongs only when both tests pass:

1. It establishes or changes something a future agent must respect when making decisions.
2. It remains durable if the triggering implementation or delivery artifact is rewritten.

## Content classes

- **Normal content:** root/domain `NODE.md` files and regular domain leaves. This is canonical current truth.
- **Archive/supporting content:** proposals, meetings, explorations, and raw material under locations such as `raw-context/`. This is evidence, not canonical truth.
- **Member content:** responsibility, ownership, and review scope under `members/`. Use it to answer who, not as a substitute for decisions.
- **Repository infrastructure:** dot directories, generated output, agent instruction files, and CI configuration. This is not tree content.

Normal content must be understandable without archive/supporting material. Normal-to-normal relationships use `soft_links` or concise prose.

## Code and tree drift

Normal content is authoritative for durable decisions but does not override observed source reality blindly. Code is the default ground truth when code and tree disagree; treat the tree as drifted and update it from source-backed evidence.

`decisionLocksCode: true` reverses that rule for one node. Use or set it only with explicit human authority. Code drift against a locked decision requires human escalation.

## What, why, and who

- **What:** state the current decision or constraint, not its timeline.
- **Why:** preserve the rationale, rejected alternatives, and surviving constraints.
- **Who:** express ownership in `owners` frontmatter and member content, not prose.

Do not change ownership without explicit human authority.

## Node shape

Every normal node requires:

```yaml
---
title: "Short noun phrase"
owners: [alice]
---
```

Optional fields include `description`, `soft_links`, `lastReviewed`, and `decisionLocksCode`. Update `lastReviewed` only after a real owner review.

Prefer body sections in this order, omitting irrelevant sections:

1. Decision
2. Rationale
3. Constraints
4. Cross-Domain

Do not add Source, Provenance, or Shipped-in sections. Git history and review artifacts carry delivery history.

## Add versus edit

Edit an existing node by default. Add a leaf only when it has a distinct noun-phrase identity, an independent ownership or linking anchor, and passes the durability tests. Add a directory only when at least three cohesive leaves share an axis. New top-level domains require explicit human-owner approval.

Keep one canonical home for each decision. Link to it from other domains instead of duplicating truth.

## Write discipline

Require a concrete source artifact for semantic writes. Read the source, target, parent, relevant links, and ownership context before editing. Write present-tense current truth, replace superseded claims in place, and keep actionable future work outside normal content.

Validate the complete prospective tree before committing. Keep each change scoped to one coherent source or audit finding.
