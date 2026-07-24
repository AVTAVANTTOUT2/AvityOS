# ADR-0009 — Native macOS remote host mode

Status: accepted for chantier 6 checkpoint 2.

## Context

Chantier 5 delivered the cryptographic protocol, ciphertext-only relay,
per-device authorization, durable cursors and metadata-only audit. No product
runtime initialized a host identity, enrolled devices or connected those
primitives to the native control-plane surfaces.

The host must remain local-first. Enabling remote access must not expose a new
control-plane listener, copy the control-plane bearer to another device, put
private keys in SQLite or let a remote client call arbitrary API routes.

## Decision

1. The control plane creates `RemoteHostManager` only on macOS. Account and
   host Ed25519/X25519 private keys, the relay administrator credential and the
   host's per-device bearer are stored as one Keychain item. The value is sent
   to the `security` process over stdin and never appears in argv.
2. `~/.avity/remote/bridge.sqlite` remains public-state-only and mode `0600`.
   It stores the account public root, signed certificates, one-time session
   hashes, revocation, connector recovery state and chained audit. The raw
   pairing secret exists only in host-process memory for the five-minute
   session.
3. The authenticated local API exposes status, configuration, offer creation,
   request acceptance and device revocation under `/v1/remote-host/*`. Every
   response is `no-store`; status never returns credentials or private keys.
4. Pairing remains out of band. The offer bundle contains the signed offer and
   high-entropy pairing secret. The returning request is encrypted. After
   acceptance, the host enrolls a new random per-device relay bearer and wraps
   that bearer, relay URL and signed acceptance in a second AES-256-GCM
   bootstrap derived from the pairing secret. The transferable bootstrap
   exposes none of those fields in clear.
5. The durable host connector makes outbound long-poll requests only. It
   decrypts a strict, versioned `RemoteControlRequest`, dispatches it in-memory
   through the authenticated local Fastify instance, then encrypts the strict
   response. No loopback token crosses the bridge.
6. The remote allowlist contains only health/project/mission/approval/run/
   terminal reads and approval resolution. Paths are exact or ID-shaped;
   project creation, terminal creation, arbitrary URLs and every other mutation
   fail before local dispatch and produce a metadata-only failed audit entry.
7. Local revocation happens before relay revocation, so an unreachable relay
   cannot make the host continue accepting messages from a revoked device.
8. Changing the relay URL is rejected until an explicit reset/migration
   workflow exists. Rotating the administrator token on the same relay and
   renaming the host remain supported; silently stranding paired devices on an
   old relay is not.

## Recovery and limits

- Relay errors put the connector in `degraded` and retry with bounded
  exponential backoff. Durable cursor/pending-response recovery remains the
  checkpoint 5.3 mechanism.
- At most eight unexpired pairing sessions may exist in host memory at once.
- A control action whose external side effect finishes immediately before a
  host process crash remains honestly at-least-once.
- The checkpoint supplies the complete host runtime and manual native
  offer/request/bootstrap workflow. The native remote-device mode that creates
  the request and consumes the bootstrap is checkpoint 6.3.
- Signed/notarized distribution and automated UI coverage remain later
  chantier 6 checkpoints.
