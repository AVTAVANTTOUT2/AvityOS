# ADR-0010 — Native macOS remote device mode

Status: accepted for chantier 6 checkpoint 3.

## Context

Checkpoint 6.2 made a Mac a complete remote host, but the native app could
still consume only a local control plane. Pairing a second Mac required a
protocol client outside the product and the existing SwiftUI screens could not
cross the ciphertext relay.

The device implementation must interoperate byte-for-byte with the Node
protocol, keep every private value out of UserDefaults and URLs, survive a
crash at each relay boundary without nonce/sequence reuse, and preserve the
host allowlist instead of introducing a second authorization model.

## Decision

1. The app implements protocol version 1 with CryptoKit: Ed25519 signatures,
   X25519 ephemeral agreement, HKDF-SHA-256 and AES-256-GCM. Public and private
   raw keys use the same strict SPKI/PKCS#8 DER wrappers as Node. Signed and
   authenticated JSON uses recursively sorted canonical object keys.
2. The device identity, private keys, signed certificates, relay bearer,
   replay cursors, outbound sequence and pending acknowledgement are one
   Keychain-only configuration. A pending pairing identity and its one-time
   secret are also Keychain-only. UserDefaults stores only the non-secret
   `local`/`remote` mode choice.
3. Pairing remains an explicit out-of-band offer → encrypted request →
   encrypted bootstrap exchange in Réglages. The app verifies the account
   signature, host and device certificates, session, expiry and identity/key
   correspondence before it accepts the relay URL or device bearer.
4. Relay access is outbound HTTPS only outside loopback. The per-device bearer
   is carried only in the Authorization header. Relay responses, inbox item
   shapes, encrypted envelopes and control responses reject unknown fields.
5. The outbound sequence is persisted before publish. A crash can therefore
   leave a harmless gap but cannot reuse an accepted sequence. After opening a
   response, the inbound sequence and pending ack cursor are persisted before
   ack; an ambiguous ack is retried before any new request. Authenticated
   responses to a pre-crash request are consumed and ignored until the current
   request response arrives.
6. `ApiClient` routes its existing GET/POST calls through the encrypted
   transport in remote mode. The same projects, missions, approvals, runs and
   terminals screens therefore retain their canonical models. SSE is disabled
   because the host allowlist exposes bounded request/response operations;
   normal ten-second polling remains the remote refresh mechanism.
7. Local mode and its API bearer remain independent. Clearing the remote
   identity atomically returns the UI to local mode. A corrupt or inaccessible
   Keychain item is reported and fails closed rather than silently selecting a
   remote configuration.

## Evidence and limits

- A committed Node-generated fixture proves Swift can verify both
  certificates, decrypt the nested pairing bootstrap and open a signed
  host-to-device envelope.
- XCTest also proves Swift seal/open, tamper and replay rejection, strict
  pairing input, Keychain rotation/deletion, encrypted relay
  publish/poll/ack, retry of an already accepted ambiguous ack, and a complete
  native-screen refresh through the relay.
- The relay still observes routing identifiers, ciphertext sizes and timing.
- Remote refresh is polling, not push. Certificate renewal, native UI
  automation, signed/notarized packaging and application updates remain later
  chantier 6 checkpoints.
