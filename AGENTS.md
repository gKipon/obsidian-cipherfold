# Cipherfold: agent entry point

Read README.md, docs/PRIVACY.md and docs/ARCHITECTURE.md first. This repository is self-contained. Do not look for a parent checkout, private service or personal vault. All fixtures must be synthetic.

## Commands

- Install: `npm ci --ignore-scripts` (Node.js 22 or 24).
- Verify: `npm run check`.
- Build: `npm run build`; output is `dist/main.js`, `dist/manifest.json`, `dist/styles.css`.
- Gateway checks, if present: `python3 -m unittest discover -s gateway -v`; install ffmpeg/ffprobe to run the real audio-duration test.

## Change boundaries

No install/update scripts may modify an Obsidian vault automatically. Do not deploy, publish, send recordings, call paid providers, or use production credentials without the user's instruction. Work in a disposable vault/profile when testing UI. Never store user content in logs, snapshots or fixtures. Do not add automatic retry of uncertain external effects.

Do not weaken bounded parsers, immutable history, conflict handling, cancellation or ciphertext read-back checks to make a test pass. Preserve protocol/version compatibility explicitly, or introduce a new version and a reviewed migration. Run targeted tests after a code change, then the full check before release. Record material changes and verification in CHANGELOG.md and relevant architecture docs; omit private operational history.

## Packaging

Release assets contain exactly the three dist files plus SHA256SUMS. The gateway, tests and docs are source-only. THIRD-PARTY-NOTICES.md is generated from the actual bundle and embedded into main.js. Never include node_modules, `.obsidian`, credentials, databases, recordings, vault exports or application profiles. Run Gitleaks on the clean Git tree and assets separately. New contributors must be able to build using only this repository and the public npm registry.
