# Security

Report vulnerabilities privately through the security advisory flow for the repository.

Context Tree treats filesystem paths, Markdown links, symlinks, write plans, and repository identities as untrusted input. Reports involving path traversal, symlink escape, stale-write bypass, credential disclosure, or validation bypass are especially important.

The package never needs repository credentials. Do not include tokens, private keys, credential-helper output, or private repository content in a report.
