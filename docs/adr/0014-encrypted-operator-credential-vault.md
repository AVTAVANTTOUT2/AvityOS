# ADR-0014 — Encrypted operator credential vault

Status: accepted for chantier 7 checkpoint 1.

## Context

Provider API keys, the control-plane bearer and the worker bearer were loaded
from owner-only environment files. Mode `0600`, redacted logs and per-provider
sandbox allowlists prevent broad accidental exposure, but backups still
contained plaintext credentials and rotation required editing multiple files.
Ambient shell credentials could also reach the wrong detached service before
the provider sandbox narrowed them again.

The vault must work on macOS and Linux without placing its master key in an
environment variable, command argument, database, log or repository. It must
also preserve the existing service-specific environment contract because the
provider adapters already enforce a smaller allowlist for each child process.

## Decision

1. `@avityos/credential-vault` stores one strict versioned document encrypted
   with AES-256-GCM, a fresh 96-bit nonce and authenticated context binding the
   schema version and full SHA-256 key identifier. The `0600` envelope is
   bounded to 2 MiB; entries and credential values are bounded and strict.
   Unknown credential names, duplicate names, NUL and multiline values fail
   closed.
2. The credential registry is closed. Provider/API/GitHub credentials belong
   only to `control-plane`; `AVITY_WORKER_TOKEN` belongs only to `worker`.
   Web receives no registered secret. The vault cannot inject `NODE_OPTIONS`,
   arbitrary configuration or a newly invented environment name.
3. On macOS, the random 256-bit master key lives in a dedicated Keychain
   generic-password item. `security` receives the value through stdin and
   verifies it by readback; the value is never argv. On other platforms the
   operator must provide an absolute owner-only key file with
   `AVITY_VAULT_KEY_FILE`. That file must remain outside both the repository
   and the operator state directory, so a normal state backup never contains
   key and ciphertext together.
4. Vault creation and updates use exclusive `0600` files, file fsync, atomic
   rename and a private process lock. A live lock blocks concurrent mutation.
   A dead-process lock is renamed and retained as stale evidence before retry;
   an invalid or foreign lock is never deleted automatically.
5. `avity vault init|status|list|set|remove|migrate` is the only operator
   surface. Secret values are accepted only from non-TTY stdin. List, JSON and
   human output contain names, scopes, timestamps, generation and key
   identifier, never values. Removal requires the exact name as confirmation;
   `set` atomically rotates an existing credential.
6. Migration reads only non-symlink, user-owned `0600` protected env files.
   It preserves the existing precedence (`operator.env` over service env),
   writes all selected credentials in one vault generation, reads them back,
   and only then atomically removes registered names from the plaintext files.
   It also removes a legacy plaintext `apiToken` field from an owner-only CLI
   config after importing and verifying it. A conflicting operator/CLI bearer
   blocks before plaintext cleanup; a credential already present in the vault
   has highest precedence and cannot be reverted by stale migration input. A
   crash can leave duplicate protected copies but cannot lose the only copy.
7. Detached services decrypt only at launch and receive only their registered
   scope in memory. Vault values override legacy plaintext values during a
   transition. Registered ambient credentials are removed from inherited
   environments before spawning every other service. Vault-control paths are
   never forwarded. The CLI API client also resolves `AVITY_API_TOKEN` from
   the vault and ignores stale plaintext `cli.json` tokens once a vault exists.
   Provider child allowlists and OS sandboxing remain a second, narrower
   boundary.
8. `avity doctor` evaluates provider auth through the same effective
   control-plane environment. An unreadable or wrong-key vault is reported as
   blocked operator configuration and cannot be masked by ambient credentials.

## Evidence and limits

- Cryptographic tests cover round-trip, wrong key, ciphertext tampering,
  malformed keys, strict names/values and absence of plaintext in envelope or
  metadata.
- File tests cover mode/ownership/symlink checks, atomic rotation/removal,
  service scoping, live/stale locks and refusal to chmod a permissive existing
  parent. Keychain tests prove the generated key is stdin-only and verified.
- CLI tests cover precedence-preserving migration, plaintext scrubbing,
  service injection, cross-service filtering, login rotation and an actual
  init/set/list file-key flow.
- The decrypted control-plane environment still exists in process memory and
  is passed to its explicitly scoped provider children. This is an at-rest and
  service-boundary control, not protection from a fully compromised operator
  account.
- Master-key rotation and portable disaster-recovery escrow are added by
  ADR-0015. Integration with an external enterprise secret manager remains
  later chantier 7 work. Losing both the Keychain/external key and the
  separately held recovery escrow makes the encrypted vault intentionally
  unrecoverable.
