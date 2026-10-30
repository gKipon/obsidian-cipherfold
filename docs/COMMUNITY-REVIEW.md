# Community directory review notes

This is an independent, MIT-licensed community codebase maintained in this repository. Its history, identifiers, build, documentation and runtime configuration are self-contained. There is no bundled hosted service, private updater, account bootstrap or production enrollment.

## Submission metadata

- Repository: https://github.com/gKipon/obsidian-cipherfold
- Release/tag: `0.1.2` (no `v` prefix).
- Minimum application version: 1.14.5; desktop only.
- License: MIT. Funding URL omitted.
- Install assets: `main.js`, `manifest.json`, `styles.css`; `SHA256SUMS` is an additional integrity file.
- Documentation: README, AGENTS, PRIVACY, ARCHITECTURE, VERIFICATION and CONTRIBUTING are in English.

## Reviewer attention

Cipherfold uses private adapter, metadata cache, editor and workspace hooks to expose encrypted notes through the native editor. It refuses ordinary vault content before installing those hooks. Use a disposable, dedicated vault and synthetic notes for review. File Recovery is disabled because it writes plaintext. Configuration changes are held in RAM except validated installed plugin IDs, explicitly allowed encrypted secrets and optional LiveSync state.

Unloading requires saving, locking and a full application restart. Persistence guards intentionally survive unload: restoring raw writes while delayed native saves exist could leak plaintext. Hot reload is rejected. This lifecycle constraint is visible in README/PRIVACY and the unload notice; it requires explicit reviewer consideration, not an assumption of guideline compliance.

No network is required for local use. Optional sync needs the operator's HTTPS CouchDB/LiveSync setup; credentials are never supplied. Selective enrollment remains an advanced interface without a consumer import wizard. Mobile, popout-window workflows, other desktop OS versions, production sync and independent cryptographic certification are not claimed.

## Local lint review

The official recommended rules were run against `src/**/*.mjs` explicitly; the directory scanner documentation currently excludes `.mjs` by default. No critical no-eval, implied-eval, unsafe-HTML, forbidden-element or lookbehind finding occurred. Advisory findings include global timers/Fetch/WebCrypto in Node-testable modules, intentional empty catches for privacy/error cleanup, and sentence-case false positives for product names, acronyms and literal URLs. The `.obsidian` literal is a reserved virtual path name, not an on-disk configuration directory lookup; disk access uses `vault.configDir`. Private wrapper closures retain an owner reference deliberately.

## Directory result — 2026-10-30

The [listing](https://community.obsidian.md/plugins/cipherfold) is public and its Add to Obsidian link is active. The automated review of version 0.1.2 completed with the displayed result **Satisfactory**. Dependency scanning found no vulnerable dependencies, and the directory reproduced main.js byte-for-byte from source. Recommendations remain for artifact attestations and the optional SHA256SUMS asset, which Obsidian does not download. The scanner also reports vault enumeration and a CSS :has performance warning; these findings do not represent a cryptographic assessment.

This records the directory's automated checks. It does not claim independent manual security certification or additional device/provider testing.
