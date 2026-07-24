# ADR-0018 — Two-phase administrator-bearer rotation

Status: accepted for chantier 7 checkpoint 5.

## Context

`AVITY_API_TOKEN` authenticates the CLI, browser session exchange and native
clients. Replacing only its encrypted vault value would immediately disagree
with the verifier in the running control plane. Restart-based credential
activation also cannot distinguish a failed response from a commit that
already revoked the old bearer. The macOS remote-host dispatcher additionally
captures an administrator token for authenticated internal requests.

The transition must always leave at least one known operator bearer valid,
survive process crashes at every boundary and never persist bearer plaintext
in SQLite, audit, logs or command output.

## Decision

1. Migration v10 adds one durable administrator-token authority row containing
   a current SHA-256 hash, an optional pending hash/rotation ID and the last
   committed rotation ID. The high-entropy bearer plaintext remains only in
   the encrypted operator vault and process/request memory.
2. A prepare request must authenticate with the current bearer. It adds one
   pending hash transactionally; the current and pending bearers are both
   accepted until commit or abort. A different concurrent prepare conflicts.
3. Startup requires the configured vault bearer to match either the durable
   current or pending hash. Any unrelated value fails closed. This permits a
   crash after either the server prepare or the vault compare-and-swap.
4. The CLI prepares first, compare-and-swaps `AVITY_API_TOKEN` in the encrypted
   vault, then uses a fresh client with the new bearer to call both the
   rotation-status and provider-status routes.
5. Commit must carry the pending bearer in the Authorization header. It
   promotes the pending hash, removes the old hash, records the rotation ID and
   updates the in-process remote-host dispatcher token. Repeating the same
   commit is idempotent.
6. Verification failure before commit compare-and-swaps the old vault value
   back, aborts pending state with the old bearer and recertifies that client.
   A concurrent vault value is never overwritten.
7. Once commit has been attempted, an ambiguous response does not roll the
   vault back because the old bearer may already be invalid. Re-running the
   command with the same stdin value verifies and finalizes pending state, or
   recognizes the already stable current state.
8. Browser cookies contain the bearer that authenticated the session. Sessions
   using the retired bearer become invalid and must log in again.

## Evidence and limits

- Network tests prove current/pending overlap, pending-only commit, immediate
  old-token revocation, idempotent commit, abort and no plaintext in SQLite.
- Startup tests accept either side while prepared and reject unrelated or
  retired bootstrap tokens.
- Operator tests prove vault CAS, protected verification, rollback,
  commit-ambiguity preservation and idempotent resume without secret output.
- `AVITY_WORKER_TOKEN`, worker certificate/CA rollover and external enterprise
  secret-manager integration remain separate checkpoints.
