# Deployment

AvityOS is local-first; the supported production shape today is a
single-host deployment of the control plane plus one or more workers.

## Control plane

```sh
pnpm install --frozen-lockfile && pnpm -r build
AVITY_DB_PATH=/var/lib/avity/avity.sqlite \
AVITY_HOST=127.0.0.1 AVITY_PORT=7717 \
AVITY_API_TOKEN=<generated token> \
node services/control-plane/dist/main.js
```

- Plain HTTP is accepted only on loopback. For remote clients, either configure
  the native TLS 1.3 listener (`AVITY_TLS_CERT_PATH`,
  `AVITY_TLS_KEY_PATH`) or keep the API on loopback behind a TLS reverse proxy.
- `AVITY_API_TOKEN` is required for any non-loopback exposure.
- Run under a process supervisor (launchd/systemd); the engine reconciles
  safely on restart (no duplicate side effects).
- Store API/provider/worker credentials in the encrypted operator vault.
  macOS uses Keychain; Linux must supply an owner-only
  `AVITY_VAULT_KEY_FILE` outside repository and operator state. Follow the
  [vault runbook](./RUNBOOKS.md#encrypted-operator-credential-vault).
- Rotate an existing administrator bearer with
  `avity vault credential-rotate AVITY_API_TOKEN --stdin`. The durable
  current/pending protocol keeps one valid client throughout the transition;
  do not replace the environment value out of band.

## Workers

Enroll once (`avity worker enroll <name>` or POST `/v1/workers/enroll`),
store the one-time token in the host's secret store, run:

```sh
AVITY_CONTROL_PLANE_URL=https://plane.example \
AVITY_WORKER_ID=… AVITY_WORKER_TOKEN=… \
AVITY_TLS_CA_PATH=/private/tls/control-plane-ca.crt \
AVITY_TLS_CLIENT_CERT_PATH=/private/tls/worker-1.crt \
AVITY_TLS_CLIENT_KEY_PATH=/private/tls/worker-1.key \
node services/worker/dist/main.js
```

Set `AVITY_TLS_CLIENT_CA_PATH` on the control plane to enable worker mTLS.
Each enrollment is then bound to the client certificate fingerprint in
addition to its one-time bearer. Existing workers must be revoked and
re-enrolled when mTLS is enabled. Private keys must be `0600` inside an
owner-only directory. Certificate files must contain the complete PEM chain
in leaf-first order; follow the
[TLS/mTLS runbook](./RUNBOOKS.md#native-control-plane-tls-and-worker-mtls).

Revoke lost hosts immediately: `avity worker revoke <id>` — revoked tokens
are rejected on the next call.
For a local operator-managed worker with an initialized credential vault, use
`avity vault worker-token-rotate`; it drains the idle worker, restarts only
that service and requires proof with the same mTLS enrollment certificate
before revoking the old bearer.
For planned renewal under the currently trusted worker CA, use
`avity tls worker-certificate-rotate --certificate <leaf-chain.pem>
--private-key <0600-key.pem>`; it keeps the bearer unchanged and promotes the
new fingerprint only after a fresh mTLS heartbeat.

## Web

`pnpm --filter @avityos/web build` produces a static `dist/`; serve it from
any static host and set `VITE_AVITY_API` at build time.

## Native macOS release channel

The public `.app` must be Developer ID signed and notarized. Stable updates are
published through the separately Ed25519-signed, HTTPS-only manifest and
applied with explicit install/rollback recovery. Follow
[`RUNBOOKS.md`](./RUNBOOKS.md#publish-and-apply-a-signed-macos-update); never
publish the ad hoc CI artifact as a public release.

## Not in scope yet

Production deployment of *user projects* (the things AvityOS builds) is
prepared per-project as deployment evidence; AvityOS does not provision
paid infrastructure without an explicit approval (policy default).
