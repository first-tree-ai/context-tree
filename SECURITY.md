# Security

Report vulnerabilities privately through this GitHub repository's security
advisory flow.

Context Tree treats filesystem paths, Markdown links, symlinks, repository
identity, branches, and local checkout state as untrusted input. Reports about
path traversal, symlink escape, checkout-identity confusion, stale-state
publication, credential disclosure, or validation bypass are especially useful.

Core and CLI operations are local and deterministic and never need repository
credentials. GitHub skills require canonical `OWNER/REPO` input and rely on the
host's existing `git` and `gh` authentication. Never include tokens, private
keys, credential-helper output, or private repository content in a report.
