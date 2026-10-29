# Encrypted format v1

The normative implementation is `src/crypto.mjs`; tests contain independent decryption and malformed-input cases. The namespace is `cipherfold-vault/*/v1`. This release does not import or migrate other plugin formats.

A random 256-bit data key encrypts records with AES-256-GCM. A passphrase-derived AES key wraps the data key: PBKDF2-HMAC-SHA256, 600,000 iterations, 16-byte random salt, 12-byte random IV and 128-bit GCM tag. Parsers bound accepted iteration counts to 600,000–2,000,000. Encryption uses a fresh random IV and binds canonical authenticated context to the vault and record routing metadata. CryptoKeys are non-extractable after import.

Header/record/replica/password parsers reject unexpected or duplicate keys, invalid UUIDs, noncanonical encodings, invalid Unicode and excessive sizes. Notes are bounded to 1 MiB, attachments to 16 MiB, envelopes to 33 MiB and headers to 4096 bytes. Keep exact schemas and authenticated context when changing the implementation. Do not rename format constants without defining a separate incompatible format.

Revision files are immutable. A new edit names its parent revision(s); concurrent heads are preserved until explicit resolution. Trash appends a deletion revision. Password generations wrap the same data key and are authenticated against the original header and prior generation. Original headers and backups remain decryptable with old passwords.
