# Security

Security properties and limitations are described in [docs/PRIVACY.md](docs/PRIVACY.md). No independent cryptographic/security certification is claimed.

Report vulnerabilities through GitHub private vulnerability reporting if enabled. Otherwise open an issue containing only a minimal non-sensitive summary and request a private channel; do not post exploits containing real secrets or private data. Only the latest release is maintained on a best-effort basis.

Before release: run the full checks, inspect source and generated assets for secrets and personal metadata, run a local secret scanner (for example Gitleaks), inspect the clean Git history and verify the packaged file list. A scanner returning zero findings is not a proof of absence. Never publish live configuration or test against someone else's deployment.
