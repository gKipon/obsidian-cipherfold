# Contributing to Cipherfold

This is an independent community project. There is no managed service, private deployment dependency, automatic updater, or synchronization with another development line. Contributions and forks are welcome under MIT; maintenance and response times are best effort.

Use Node.js 22 or 24, `npm ci --ignore-scripts`, and `npm run check`. See [AGENTS.md](AGENTS.md) for the architecture and invariants. Use only synthetic data in tests and reports. Never attach vaults, recordings, enrollment kits, keys, tokens or machine-specific paths. Discuss format/protocol changes before implementing them. Preserve upstream license notices.

Describe the user-visible problem, behavior after the change, tests and compatibility risks in each pull request. Do not silently broaden network access, telemetry, permissions or durable plaintext storage. Runtime changes need meaningful regression tests; documentation corrections do not.
