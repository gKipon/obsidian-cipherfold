# Verification record — 0.1.2 community review candidate

Checked on 2026-10-30 in disposable environments with synthetic data only.

- JavaScript regression suite: 156 passing tests.
- Six additional tests cover interrupted startup, late lock setup, validated plugin-ID persistence and rejection of arbitrary config plaintext.
- Obsidian 1.14.5, separate application identity/profile/vault: the 0.1.1 baseline verified native editor save, lock, cold restart and exact text recovery.
- Version 0.1.2: disabling through application settings persists after cold restart; re-enabling and unlocking restores the same exact encrypted note, then locks successfully.
- Local password rotation verifies its immutable credential file; the running application accepts the new password after restart.
- Unload after lock reports the required full restart. Guards intentionally remain; this is disclosed for directory review.
- Shared synthetic vault disk scan: note marker, fake device token and configured endpoint are absent in plaintext.
- Official eslint-plugin-obsidianmd 0.4.2 recommended rules were run explicitly on all source .mjs files. No security-critical scanner rule failed. Advisory findings remain; see COMMUNITY-REVIEW.md.

# Previous 0.1.0 baseline

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
