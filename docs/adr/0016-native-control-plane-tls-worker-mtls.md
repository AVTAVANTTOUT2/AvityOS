# ADR-0016 — Native control-plane TLS and certificate-bound workers

Status: accepted for chantier 7 checkpoint 3.

## Context

The worker already refused clear HTTP away from loopback, but the control plane
had no native TLS listener. Remote deployments therefore depended entirely on
an external reverse proxy, and a worker bearer copied from one host could be
used from another TLS client. Adding a private CA must not force administrator,
browser and CLI clients to possess a worker certificate.

TLS material is deployment configuration, not an application credential:
private keys must remain outside the repository and operator state, and the
runtime must not weaken global Node trust through `NODE_TLS_REJECT_UNAUTHORIZED`
or ambient `NODE_EXTRA_CA_CERTS`.

## Decision

1. The control plane accepts a native certificate/key pair through absolute
   owner-controlled paths and serves TLS 1.3 only. Without that pair, it
   refuses every non-loopback bind; loopback HTTP remains available for local
   development.
2. Configuring a worker client CA enables mTLS on worker enrollment, lease,
   heartbeat and terminal output/exit routes. TLS asks for a client
   certificate without rejecting certificate-less connections globally:
   administrator, browser and CLI routes remain bearer/session authenticated,
   while the application layer fails closed on every worker data-plane route.
3. Enrollment stores the authorized client certificate's normalized SHA-256
   fingerprint beside the independently hashed worker bearer. Every later
   worker call must present both the bearer and the same authorized
   certificate. A different certificate signed by the same CA cannot reuse a
   stolen bearer. The fingerprint is never returned by the API; worker listing
   exposes only a `mutualTls` boolean.
4. Migration v9 leaves existing workers unbound (`NULL`). Enabling worker mTLS
   therefore requires explicit re-enrollment under the intended certificate;
   legacy bearer rows do not silently acquire or bypass an identity.
5. CLI and worker clients use a dedicated bounded HTTPS transport with an
   explicit private CA, optional client certificate/key, TLS 1.3 minimum,
   hostname verification, an optional DNS-name override, bounded response size
   and bounded connection pooling. This changes trust only for that client.
6. PEM paths must be absolute and non-root. Symlinks and foreign ownership are
   rejected. Private keys must be regular `0600` files in a non-symlink
   owner-only directory; certificates must be owner-readable and not writable
   by group or others. Material is parsed before a listener or client starts.
7. Native HTTPS sessions add the `Secure` cookie attribute. Bearer
   authentication, CORS, worker token hashing, revocation and lease fencing
   remain independent layers.

## Evidence and limits

- Transport tests cover mismatched configuration, non-loopback plaintext
  refusal, invalid permissions/symlinks and valid server/client material.
- A real TLS 1.3 Fastify/worker integration test generates a private CA and
  three certificates, rejects certificate-less enrollment, executes an actual
  leased terminal with the enrolled identity, and rejects a stolen bearer used
  with another certificate signed by the same CA. It also proves bearer-only
  administrator access over the private CA, a `Secure` session cookie, and
  fingerprint non-disclosure.
- Fresh-database coverage proves migration v9 and the fingerprint column.
- Certificate issuance, CA custody, expiry monitoring and certificate/bearer
  rotation remain operator responsibilities in this checkpoint. Replacing a
  bound worker certificate requires revocation and re-enrollment until the
  following credential-lifecycle checkpoint adds an explicit rotation
  protocol.
