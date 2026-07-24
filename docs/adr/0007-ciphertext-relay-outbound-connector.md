# ADR-0007 — Ciphertext-only relay and outbound host connector

Status: accepted for chantier 5 checkpoint 2.

## Context

ADR-0006 defines device trust, pairing and end-to-end envelopes, but it does
not transport them. Exposing the local control plane through an inbound tunnel
would enlarge its trust boundary and would give the tunnel or relay access to
application plaintext.

The transport must keep the host local-first: a hosted intermediary may retain
and route encrypted envelopes, while the host initiates every network
connection and decrypts only on the local machine.

## Decision

1. `@avityos/remote-relay` is a separate Fastify service. It accepts only the
   strict `RemoteEncryptedEnvelope` contract and never imports the bridge
   cryptographic implementation or any control-plane package.
2. The relay maintains bounded recipient inboxes, contiguous per-inbox cursors,
   duplicate detection by message ID plus envelope fingerprint, expiry,
   long-poll delivery and idempotent cursor acknowledgement. Per-inbox, total
   queue item/byte totals, cursor-state, deduplication and concurrent-waiter
   memory all have independent hard limits.
3. Every relay operation except exact-path health requires a bearer access
   token in the Authorization header. Tokens are forbidden from URLs and
   responses are marked `Cache-Control: no-store`.
4. `RemoteRelayHttpClient` requires HTTPS outside loopback and has no insecure
   remote escape hatch. The relay binary also refuses a non-loopback bind; a
   remote deployment must use a same-host HTTPS reverse proxy.
5. `RemoteOutboundConnector` opens only outbound HTTP requests. It long-polls
   its host-device inbox, verifies and decrypts locally, calls a local handler,
   encrypts any response for the sender, publishes it, then acknowledges the
   relay cursor.
6. A pending delivery retains its exact encrypted response across ambiguous
   publish/ack failures, so an in-process retry does not rerun the handler or
   mint a second response.
7. Before decrypting any batch, the connector requires contiguous relay
   cursors and a consistent `nextCursor`; missing or reordered delivery fails
   closed before the local handler runs.

## Security properties and visible metadata

The relay never receives private keys, pairing secrets, application plaintext
or the local control-plane token. It can observe account/device routing IDs,
message IDs, content types, ciphertext sizes, cursors and timing. It can drop,
delay or reorder ciphertext; signatures, AEAD authentication and recipient
sequence guards detect forgery and replay at the endpoint.

The checkpoint uses one deployment access token and in-memory queues. That
token is a denial-of-service gate, not device identity authorization: a holder
can read or acknowledge any ciphertext inbox. Queues, connector cursors and
pending deliveries are lost on process restart, and handler execution is not
crash-safe exactly-once. These are explicit checkpoint limits, not production
claims.

Checkpoint 5.3 adds durable accounts/devices, per-device relay authorization,
atomic one-time pairing storage, revocation, durable replay/delivery cursors
and audit binding for each decrypted remote action.

## Rejected alternatives

- Public inbound access to the control plane: expands the attack surface and
  bypasses the E2E application boundary.
- TLS-only relay payloads: lets the relay terminate TLS and read application
  commands.
- Tokens in long-poll query strings: leaks credentials through URLs and logs.
- Acknowledgement before local handling: can lose actions on a connector crash.
- Claiming exactly-once with volatile state: cannot survive process failure.
