# Integration Guide

Consumers should import `@first-tree-ai/context-tree` rather than copying parsers, validators, policy text, or templates.

## Local authority

Every API accepts an explicit tree path. A hosting product is responsible for establishing which path and revision the caller is authorized to use before invoking this package.

## Git authentication

This package performs no network Git operations. A host integration may clone, fetch, or push with the operator's normal credential helper or SSH agent. Run agent-owned network commands non-interactively, clear inherited repository overrides such as `GIT_DIR` and `GIT_WORK_TREE`, and keep repository URLs credential-free.

Git transport access and forge API access are independent. Check `git ls-remote` for transport and `gh auth status` or `glab auth status` only for provider API operations.

## First Tree

First Tree should pin an exact package version and retain Team membership, binding, freshness, snapshot, write-consent, observability, and reviewer checks in its adapter layer. Compatibility wrappers may preserve old command names, but portable behavior should delegate to this package.
