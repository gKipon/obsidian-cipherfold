# Privacy and security boundaries

## Stored data

- `CipherfoldStore/vault.rvkey`: public format version, random vault UUID, KDF parameters, salt, IV and encrypted data key. No plaintext passphrase.
- `CipherfoldStore/<object UUID>_<revision UUID>.renc`: authenticated encrypted records. Titles, MIME metadata, timestamps inside records, note content and attachment bytes are encrypted. Outer routing metadata reveals object/revision relationships, kinds, counts and ciphertext lengths; filesystem timestamps and traffic patterns also remain observable.
- Plugin directory: encrypted attachment catalog (`attachment-catalog.rvcat`), encrypted replica config/state and password credentials. `session-state.json` contains idle timeout and last-open object UUID, not its title or content. Enrollment kits contain the public header and encrypted credentials/configuration; protect them like a backup.
- Obsidian OS-encrypted SecretStorage may persist through the normal encrypted application slot. The enabled community-plugin list may persist only as a bounded array of unique, currently installed plugin IDs, so disabling the plugin survives restart. Other local metadata/workspace configuration is held in memory. An optional LiveSync `data.json` is explicitly allowed to persist; its settings and credential protection are controlled by LiveSync, not by Cipherfold. Review those settings separately.

## Threat model

The design protects encrypted files against offline inspection and detects tampering through authenticated encryption and strict parsing. It does not protect an unlocked session from malicious plugins, a compromised OS, screenshots, swap, crash dumps, clipboard copying, OS/application backups or a debugger. JavaScript cannot guarantee erasure of every memory copy. Use full-disk encryption and a trusted plugin set.

A wrong password, corrupt record, conflicting revision, late network response or interrupted save must not silently replace history. Writes append new ciphertext revisions and verify read-back. Failed saves leave the session available for recovery. The 50,000-revision write limit preserves history; no automatic deletion takes place.

Creation and password-change UI require 12 characters. The bounded decoder accepts format passwords from four characters for compatibility tests; this does not make short passwords safe. Use a strong passphrase. Password changes rewrap the same data key: old headers/backups still accept the old password and compromise is not revoked.

## Network

No telemetry, default server, updater or account bootstrap exists. Local mode makes no plugin network requests. Optional replica operations contact only the explicitly configured HTTPS CouchDB service. Replica requests reject redirects and omit cookies. Server operators see encrypted objects, sizes, identifiers, timing and authentication metadata. Cipherfold does not operate that service. Other installed plugins may make their own requests.

## Lifecycle

Cipherfold changes private adapter, cache, workspace and editor behavior. This requires a dedicated vault and revalidation on Obsidian upgrades. File Recovery is disabled. Guards remain until full application restart when the plugin unloads to avoid flushing plaintext through restored raw writes. Hot reload is refused. If saving fails, do not quit merely to clear an error: preserve the open session and recover the pending text deliberately.
