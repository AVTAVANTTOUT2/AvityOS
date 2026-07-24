# ADR-0012 — Remote bridge certificate renewal

## Status

Accepted.

## Context

Remote device and host certificates expire after 365 days. Pairing again would
rotate the per-device relay bearer and create an unnecessary new identity.
Letting a certificate expire would instead make every encrypted envelope fail
closed, including a renewal request.

Renewal must therefore happen before expiry, preserve the existing device
identity and bearer, survive relay restarts, and never become a path that
reactivates a revoked device.

## Decision

1. Both native clients use a fixed 30-day renewal window. The host checks its
   certificate at startup and at every outbound-connector iteration. A remote
   Mac checks both certificates before each normal encrypted request.
2. A remote Mac requests renewal with the strict, versioned
   `POST /v1/remote/certificates/renew` control message. The message travels
   through the existing signed and end-to-end encrypted bridge.
3. The account root signs a new 365-day certificate over the same account ID,
   device ID, name and Ed25519/X25519 public keys. Keys and relay bearers are
   not rotated by this operation.
4. The relay exposes a separate administrator-only certificate update. It
   preserves the stored bearer hash and revocation field, requires a strictly
   later issue/expiry interval, rejects identity changes, and returns a
   conflict for revoked devices. Device re-registration remains the explicit
   credential-rotation/re-enrollment operation.
5. The host updates the relay before its local public state and Keychain
   configuration. Retrying after an interrupted update is idempotent; the
   connector's durable message/cursor state still owns response delivery.
6. The native client accepts a response only after validating both account
   signatures, unchanged identities/keys, non-regressing validity intervals
   and its own private/public identity match. Only then does it replace the two
   certificates in Keychain. Relay token, sequences, cursors and pending ack
   state are preserved.
7. An already expired remote certificate cannot authenticate the renewal
   envelope. Recovery is intentionally fail-closed and requires revocation
   followed by a new out-of-band pairing.

## Consequences

- Normal use renews certificates without user intervention; Settings also
  shows both expiry timestamps and offers an explicit renewal action.
- A relay database restart keeps the same bearer valid after renewal.
- Certificate renewal cannot undo revocation or silently rotate trust keys.
- Root-account key rotation and relay migration remain separate, explicit
  future workflows.
