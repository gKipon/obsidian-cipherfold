# Cipherfold

Encrypted, append-only notes in a **dedicated desktop Obsidian vault**, using the native Markdown editor, links and search while unlocked. Titles, content and attachments are encrypted on disk; revisions and deletion records are retained.

**Community release 0.1.2.** [View in the Community Plugins directory](https://community.obsidian.md/plugins/cipherfold). Requires Obsidian 1.14.5 or later on desktop. Uses private Obsidian APIs and must be revalidated after Obsidian upgrades. Mobile is intentionally disabled. No independent security certification is claimed. Start with synthetic notes and keep verified backups.

## Install and create a vault

1. Create a new, empty Obsidian vault. Do not install into your existing notes vault. Ordinary root files/folders make startup fail before adapter/cache hooks are installed.
2. In that dedicated vault, install Cipherfold from the [Community Plugins directory](https://community.obsidian.md/plugins/cipherfold). For manual installation, from this repository's GitHub release download `main.js`, `manifest.json` and `styles.css`; verify `SHA256SUMS`. Copy the three files into `<new-vault>/.obsidian/plugins/cipherfold/`.
3. Enable Community plugins, then Cipherfold. Click the lock icon and choose a unique passphrase of at least 12 characters. There is no recovery service.
4. Create a note using the normal Obsidian command; it appears under `Native`. Use **Create notebook** for folders. Save and use **Lock encrypted notes** before closing.
5. Default inactivity lock is five minutes. Configure it through **Automatic lock: change timeout**. Switching windows alone does not lock notes immediately.

File Recovery is disabled in this dedicated vault because it persists plaintext. Metadata, workspace state and virtual Markdown files are intercepted into memory. Configuration changes made while the plugin is active may not persist, except the validated enabled-plugin ID list, specifically allowed encrypted secrets and synchronization state. Other plugins can access plaintext while unlocked. Read the complete [privacy boundaries](docs/PRIVACY.md).

**Disable/update:** finish saving, lock, disable or replace the plugin, then fully quit and restart Obsidian. Guards intentionally remain until restart; hot reload is refused. Never disable it in order to bypass a failed save.

## Backup and restore

After saving and locking, copy the entire `CipherfoldStore/` directory and the `.obsidian/plugins/cipherfold/` directory to a protected backup destination. The latter includes password generations and encrypted replica metadata. Keep several snapshots; test restoration into a separate empty vault. Restore files while Obsidian is closed, install the same compatible plugin version, then unlock. Do not merge different vaults or rename ciphertext records.

Encrypted trash and immutable revisions are not a substitute for an independent backup. This release has no history pruning or automatic migration. The synthetic recovery CLI under tests is a test fixture, not a supported production recovery tool.

## Optional synchronization

Local operation needs no account or network. Advanced replication uses an operator-provided HTTPS CouchDB server and a separately installed/configured Self-hosted LiveSync plugin for the full replica. See [SYNC.md](docs/SYNC.md). No server, database or credentials are supplied. Local vaults can use **Change access password** without a server. Enrolled replicas require a reachable server and a verified password-generation exchange. Selective replication requires enrollment.

## Development

```sh
npm ci --ignore-scripts
npm run check
```

Use Node.js 22 or 24. Build output is in `dist/`; no parent checkout or global build tool is needed. See [AGENTS.md](AGENTS.md), [architecture](docs/ARCHITECTURE.md), [format](docs/FORMAT.md), [contributing](CONTRIBUTING.md) and [verification](docs/VERIFICATION.md).

MIT licensed; bundled upstream licenses are preserved in [THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) and `main.js`. This is an independent community development line with no connection to any managed deployment.
