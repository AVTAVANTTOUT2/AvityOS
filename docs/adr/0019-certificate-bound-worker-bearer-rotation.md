# ADR-0019 — Certificate-bound worker-bearer rotation

Status: accepted for chantier 7 checkpoint 6.

## Context

Worker bearers are stored only as hashes and, for mTLS enrollments, bound to
one certificate fingerprint. Replacing the operator-vault token alone would
disconnect the worker; replacing the server hash first would invalidate the
running process. A restart during active terminal execution could also lose
output or side effects.

The next bearer must therefore be generated and handed off without plaintext
persistence, while no new work can race the restart and the existing mTLS
identity remains mandatory.

## Decision

1. Migration v11 adds pending-token hash, rotation ID, pending-proof timestamp
   and last committed rotation ID to each worker row. Token plaintext is never
   stored in SQLite, audit, logs, argv or command output.
2. An administrator may prepare rotation only for a non-revoked worker with no
   starting/running/cancelling terminal. Preparation generates 24 random bytes,
   stores only the SHA-256 hash, and atomically moves the worker to `draining`;
   draining workers authenticate but cannot lease new work.
3. Current and pending bearer hashes overlap during preparation. Every worker
   route still requires the row's exact enrolled certificate fingerprint when
   mTLS is enabled. Pending proof is recorded only after both bearer and
   certificate checks pass.
4. `avity vault worker-token-rotate` requires an existing worker-scoped vault
   entry plus running local control-plane/worker services. It compare-and-swaps
   the generated token into the encrypted vault, restarts only the worker and
   waits for a fresh heartbeat with the pending role.
5. Commit is refused before pending proof. It atomically promotes the pending
   hash, clears rotation state, records the rotation ID and returns the worker
   online. Repeated commit is idempotent and the old bearer is immediately
   rejected.
6. A pre-commit failure compare-and-swaps the old token back, aborts pending,
   restarts the worker and proves a fresh current-token heartbeat. Concurrent
   vault values are never overwritten. If commit is ambiguous, the new value
   remains stored; a prepared state is safely resumed on the next command.
7. A prepared rotation found with the vault still holding the current token is
   aborted before a fresh server-generated attempt. This recovers a lost
   prepare response without needing to persist or redisplay the pending secret.

## Evidence and limits

- Integration tests prove active-work refusal, draining, current/pending
  overlap, commit-before-proof refusal, pending proof, promotion and old-token
  revocation without plaintext database storage.
- The real TLS network fixture proves that pending + rogue certificate does not
  mark proof, while pending + exact enrollment certificate does.
- Operator tests prove vault CAS, scoped activation, ambiguous preservation,
  pending resume and secret-free result/argv behavior.
- Worker certificate renewal, CA rollover and external enterprise secret
  managers remain separate checkpoints.
