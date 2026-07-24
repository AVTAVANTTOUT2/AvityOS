# ADR-0006 — Remote bridge identity and end-to-end envelopes

Status: accepted for chantier 5 checkpoint 1.

## Context

The existing worker transport is an authenticated HTTPS connection directly to
the control plane. It is not a remote bridge: a relay or reverse proxy can see
application plaintext, there is no account/device trust root, and pairing,
revocation and replay state are not modeled.

The remote bridge must remain local-first. A relay is optional and untrusted:
it may route and retain ciphertext but must never receive account private keys,
device private keys, pairing secrets or application plaintext.

## Decision

1. A remote account owns an Ed25519 root signing key.
2. Every device owns an Ed25519 signing key and an X25519 agreement key.
3. The account root signs short, versioned device certificates. Relay-visible
   certificates contain only public keys and bounded routing metadata.
4. Pairing uses a 256-bit secret transferred out of band (for example in a QR
   code). The relay receives only an AES-256-GCM encrypted request and
   acceptance. Pairing sessions are time-bounded and must be consumed
   atomically by the persistence layer.
5. Each application message uses a fresh ephemeral X25519 key, HKDF-SHA-256,
   AES-256-GCM and an Ed25519 sender signature. Routing metadata is authenticated
   as AEAD additional data and by the signature.
6. Each sender/recipient channel carries a strictly increasing sequence.
   Durable consumers reject replayed or reordered envelopes before decryption.
7. The protocol uses strict Zod contracts and a fixed protocol version. Unknown
   fields and plaintext-shaped relay payloads are rejected.

`@avityos/remote-bridge` implements these pure cryptographic operations.
Checkpoint 2 will add a ciphertext-only relay and outbound host connector.
Checkpoint 3 will persist accounts, devices, one-time pairing sessions,
revocations and replay cursors and will bind every remote action to the existing
AvityOS audit chain.

## Security properties and limits

- The relay can observe account/device routing identifiers, sizes and timing.
  It cannot decrypt or forge application messages without device private keys.
- Pairing secrecy depends on the out-of-band channel and one-time atomic
  consumption. The raw pairing secret is never a relay field.
- AES-GCM nonces and per-message ephemeral keys are randomly generated.
- Signatures authenticate senders; certificates bind their public keys to the
  account root.
- This checkpoint does not yet implement revocation distribution, durable
  anti-replay storage, traffic padding, multi-relay anonymity or a double
  ratchet. Those properties must not be claimed until later checkpoints.

## Rejected alternatives

- TLS termination at the relay: exposes plaintext to the relay.
- Shared account bearer tokens on every device: no per-device revocation or
  cryptographic attribution.
- Persisting the pairing secret at the relay: turns relay compromise into
  device enrollment compromise.
- Unauthenticated encryption without device signatures: permits sender
  substitution by any account member with only a recipient public key.
