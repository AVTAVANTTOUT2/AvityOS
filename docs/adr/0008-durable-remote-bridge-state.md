# ADR-0008 — Durable remote bridge state, device authorization and audit

Status: accepted for chantier 5 checkpoint 3.

## Context

Checkpoint 5.2 deliberately used a deployment-wide relay token and volatile
queues/cursors. That is sufficient to prove the ciphertext transport, but not
to revoke one device, survive a restart or attribute decrypted actions.

## Decision

1. The relay administrator token is accepted only by `/v1/admin/*`. It enrolls
   or rotates a device credential and revokes a device. Data-plane publish,
   poll and acknowledgement require that device's own bearer.
2. Publishing binds authenticated account/device headers to the signed
   envelope sender. Poll and acknowledgement bind the credential to the exact
   recipient path. A revoked credential fails immediately, and publish refuses
   inactive or unknown recipients instead of allocating orphan inboxes.
3. The production relay store is SQLite with STRICT tables, immediate
   transactions, WAL, prepared statements and a `0600` database file. It
   persists public certificates, SHA-256 token hashes, ciphertext inboxes,
   deduplication fingerprints and contiguous delivery cursors. Ciphertexts and
   deduplication records expire; cursor watermarks remain monotonic, preventing
   a reset after a message-free interval. If an actually queued envelope
   expires before delivery, the resulting gap remains explicit and the
   connector fails closed instead of silently skipping an action.
4. The local `RemoteBridgeStateStore` persists account public roots, device
   certificates/revocation, secret-hash-only pairing sessions, connector
   state and metadata-only remote action audit. It never accepts or persists
   account/device private keys or raw pairing secrets.
5. Pairing session consumption is an atomic transaction. Connector state
   includes pending encrypted responses and sequence/cursor progress.
6. `createDurableRemoteOutboundConnector` makes persistence and audit
   mandatory. Each transition is saved around publish/sequence/ack boundaries;
   ambiguous retries reuse the exact ciphertext and audit is idempotent per
   local-device/message. It refuses a revoked local identity and checks remote
   sender revocation before decrypting or invoking the local handler.
7. Remote audit entries contain only account/device/message IDs, content type,
   action, outcome and bounded error code. They form a SHA-256 previous-hash
   chain whose integrity is independently verifiable.

## Security and recovery properties

- Relay compromise still exposes routing IDs, certificates, sizes and timing,
  plus token hashes and ciphertext, but not private keys or application
  plaintext.
- A stolen device bearer authorizes only that device until revocation. The
  administrator token remains a high-value deployment secret and must be
  stored separately from device and control-plane credentials; enrollment
  rejects an administrator token reused as a device token.
- Relay restart preserves queued envelopes, cursor continuity, deduplication,
  enrollment and revocation.
- Connector restart preserves an already-materialized encrypted response and
  resumes publish/ack without calling the handler again.
- A process crash inside an arbitrary external handler, before the handler
  returns and state/audit can be committed, can still cause at-least-once
  execution. The design does not claim impossible generic exactly-once
  semantics for external side effects.

Private keys belong in the platform secret store (Keychain on macOS), never in
these SQLite databases. The native pairing/remote user experience is delivered
by chantier 6 on top of this completed bridge core.
