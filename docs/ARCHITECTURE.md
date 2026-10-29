# Architecture

`src/main.mjs` coordinates the native Obsidian adapter/cache bridge, editor saves, resources and lock lifecycle. `onboarding.mjs` checks raw disk before hooks and creates a new dedicated encrypted vault. `virtual-store.mjs` projects `Native/` into memory; `store.mjs` owns immutable records and conflict/history validation. `crypto.mjs` is the sole WebCrypto format implementation. `editor-revisions.mjs` and `note-workflow.mjs` prevent stale saves, unsafe rename and destructive deletion.

`resource-cache.mjs` supplies in-memory attachment resources. `session-lock.mjs` persists only lock timeout and a last-open UUID. `secret-storage-guard.mjs` validates the existing OS-encrypted Obsidian secret slot before permitting persistence.

Optional replication is split into pure planning (`selective-policy.mjs`, `replica-model.mjs`), state machine (`replica-engine.mjs`), bounded CouchDB transport (`replica-transport.mjs`), pinned upstream codec (`replica-codec.mjs`) and UI (`replica-runtime.mjs`). Password-generation verification and rotation are in `password-manager.mjs`; UI is in `password-runtime.mjs`.

Test layers cover strict schemas, tampering, independent crypto interoperability, Unicode, sizes, attachments, stale writers, lock races, metadata persistence, editor operations, immutable transport read-back, conflicts, password generations and selective-replica budgets. Bridge tests mock private Obsidian interfaces; real application smoke tests remain necessary.

Build imports only pinned codec modules from `@vrtmrz/livesync-commonlib` 0.2.0 and `octagonal-wheels` 0.1.55. No PouchDB runtime is instantiated. Build-time upstream logging is replaced with a no-op to prevent serialized private error objects. `uuid` is overridden to patched 11.1.1 (GHSA-w5hq-g745-h8pq); it is a transitive installation dependency, not a bundled runtime dependency. Licenses are derived from esbuild's actual input graph.
