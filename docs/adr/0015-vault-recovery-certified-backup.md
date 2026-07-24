# ADR-0015 — Vault recovery and certified operator backup

Status: accepted for chantier 7 checkpoint 2.

## Context

ADR-0014 deliberately separated the encrypted credential vault from its
Keychain or external-file master key. This prevented a normal operator-state
copy from containing both key and ciphertext, but losing the key made the vault
unrecoverable. Raw SQLite copies could also omit committed WAL state or be
accepted without verifying migrations, foreign keys or the chained audit log.

Recovery must remain portable across macOS and Linux without exposing a raw key
in argv, output, the repository, operator state or a normal backup bundle. A
restore command must never overwrite live state as a side effect of a
rehearsal.

## Decision

1. A recovery envelope contains exactly one vault master key encrypted with
   AES-256-GCM. Its 256-bit wrapping key is derived from a 16–1024 byte
   operator passphrase using scrypt (`N=32768`, `r=8`, `p=1`) and a random
   128-bit salt. Version, KDF parameters and the SHA-256 master-key identifier
   are authenticated as AAD. The strict JSON envelope is bounded, owner-only
   `0600`, atomically written and must reside outside repository and operator
   state. Passphrases are non-TTY stdin only.
2. Both Keychain and external-file key stores support compare-and-swap
   replacement with readback verification. Keychain writes keep the key out of
   argv. File replacement uses an fsynced `0600` temporary file and atomic
   rename in a private owner-only directory.
3. Master-key rotation first authenticates the current escrow against the
   current vault and key store. It stages a separately encrypted `.next`
   escrow, replaces the key store, then re-encrypts the unchanged entries
   under the vault lock while incrementing the generation. Failure before the
   vault commit restores the old key-store value and removes the stage.
   Successful rotation atomically replaces and verifies the recovery envelope,
   key store and reopened vault. An ambiguous post-commit state is retained for
   operator inspection, never silently deleted.
4. A certified backup uses SQLite `VACUUM INTO` on a read-only connection, so
   one consistent snapshot includes committed WAL state without loading the
   database into process memory or requiring the `sqlite3` CLI. The source and
   every output file must be regular, owner-owned and `0600`; directories are
   `0700`. Database and vault sizes are bounded.
5. Certification requires SQLite integrity and foreign-key checks, a
   contiguous migration history, independent recomputation of the complete
   audit SHA-256 chain, and successful vault authentication with the separately
   held recovery envelope. A strict manifest records SHA-256/size, counts,
   migration version, audit head, vault generation and key identifier. It
   contains no raw key or credential value.
6. Restore first verifies the source bundle and requires its exact random
   bundle identifier as confirmation. It writes only to a new external
   directory, streams bounded files, and re-runs the complete certification
   before atomic publication. It never replaces a running database, vault or
   key store.
7. Persistent control-plane SQLite directories are protected as `0700` and
   database/WAL files as `0600`; symlinked or foreign-owned database files fail
   closed.

## Evidence and limits

- Cryptographic and file tests cover recovery round-trip, wrong passphrase,
  tamper, bounds, permissions, no raw key, compare-and-swap and Keychain
  stdin-only replacement.
- Operator tests cover successful rotation, preserved values/metadata,
  pre-commit key-store rollback, lost-key recovery and exact confirmation.
- A live-file test keeps the source SQLite connection open in WAL mode,
  creates audited state, certifies a backup, restores it to a fresh root,
  opens both restored stores and detects byte-level backup corruption.
- Backup covers the core orchestration database and encrypted operator vault.
  Remote bridge/relay stores, macOS application identities, Apple signing
  credentials and update-signing keys retain separate lifecycle policies.
- Passphrase custody and off-site media remain operator responsibilities.
  This checkpoint does not integrate an enterprise secret manager or perform
  automatic disaster cutover.
