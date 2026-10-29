# Verification record — 0.1.0 release candidate

Checked on 2026-10-30 with synthetic data only.

- JavaScript regression suite: 142 tests passing.
- Standalone esbuild build from pinned npm dependencies; all runtime dependency licenses embedded.
- npm audit: zero reported vulnerabilities after the documented transitive override in Cipherfold.
- Isolated desktop Obsidian 1.14.5 profile/vault smoke checks; no existing installation used.
- Real native editor: create, save, lock, remove virtual files from view, unlock and recover exact text; File Recovery disabled.
- Cold application restart: starts locked and restores encrypted notes after unlock. Synthetic plaintext sentinel absent from vault files.
- Dedicated-vault guard rejects ordinary content before hooks. Redirect credentials test passes. Tamper, conflict, failed-write and lock-race tests pass.

Not verified: mobile, all desktop operating systems, production-scale performance, independent cryptographic review, or a freshly deployed public-namespace LiveSync/CouchDB installation. Selective enrollment has no consumer import wizard; the optional interface is for advanced testing. Compatibility beyond Obsidian 1.14.5 must be revalidated because private APIs are used.

## Reproduce and extend

Run `npm ci --ignore-scripts && npm run check`, then the gateway tests if present. Perform integration tests only in a disposable application profile and empty test vault. Before publishing, scan the complete source tree, generated assets and Git history for secrets and private metadata; verify that a clean checkout reproduces release assets. Check actual uploaded asset hashes after release. Never treat a passing scanner as proof of no possible leak.
