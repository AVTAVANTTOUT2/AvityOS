# ADR-0020 — Two-phase worker mTLS certificate rotation

Status: accepted for chantier 7 checkpoint 7.

## Context

An mTLS-enrolled worker is bound to the SHA-256 fingerprint of exactly one
client certificate. Replacing the certificate files before changing that
fingerprint disconnects the worker; changing the fingerprint first rejects the
running process. Revocation and re-enrollment also rotate the independent
bearer unnecessarily and create an avoidable service gap.

Certificate rollover needs a bounded overlap, proof that the candidate private
key is actually usable through the configured worker CA, and crash recovery
without persisting PEM or private-key material in SQLite.

## Decision

1. Migration v12 adds a pending mTLS fingerprint, rotation ID, proof timestamp
   and last committed rotation ID to each worker. Only SHA-256 fingerprints
   are durable; certificate PEM and private keys are never stored in SQLite,
   audit or command output.
2. An administrator prepares a currently valid, non-CA X.509 leaf certificate.
   Preparation is refused for legacy non-mTLS rows, revoked workers, active
   terminals, the already-active certificate or any concurrent worker bearer
   or certificate rotation. It atomically moves the worker to `draining`.
3. Current and pending fingerprints overlap only while prepared. A pending
   certificate is considered proven solely after Node TLS authorizes its chain
   against `AVITY_TLS_CLIENT_CA_PATH` and a worker data-plane request also
   authenticates the unchanged bearer. A different certificate signed by the
   same CA remains unauthorized.
4. `avity tls worker-certificate-rotate --certificate … --private-key …`
   validates strict file ownership/modes and key/certificate compatibility,
   atomically stages only their protected paths, restarts only the worker and
   requires a fresh pending-certificate heartbeat.
5. Commit is refused before proof. It atomically promotes the pending
   fingerprint, clears rotation state and returns the worker online. Commit is
   idempotent; the retired certificate is rejected immediately.
6. A pre-commit failure restores the previous protected paths without
   overwriting concurrent changes, aborts pending, restarts the worker and
   proves the current certificate again. An ambiguous commit preserves the
   candidate paths and is resumed with the same files.
7. Bearer and certificate rotations are mutually exclusive. They remain
   cryptographically independent factors and neither protocol silently changes
   the other.

## Evidence and limits

- A real TLS fixture generates a worker CA plus current, candidate and unrelated
  client certificates. It proves commit-before-proof refusal, old/new overlap,
  unrelated-certificate rejection, candidate proof, idempotent commit and
  retired-certificate rejection.
- Operator tests prove atomic path staging, successful activation, certified
  rollback, ambiguous recovery and absence of PEM/private-key material from
  persisted environment and results.
- Certificate issuance, expiry monitoring, private-CA custody and trust-anchor
  rollover remain deployment responsibilities. CA rollover requires a
  separately bounded dual-trust protocol before the old CA can be removed.
