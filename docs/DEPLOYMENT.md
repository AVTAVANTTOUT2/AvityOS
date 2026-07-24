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

- Keep the API bound to loopback and put TLS termination + auth proxying
  in front (Caddy/nginx) if remote clients must reach it.
- `AVITY_API_TOKEN` is required for any non-loopback exposure.
- Run under a process supervisor (launchd/systemd); the engine reconciles
  safely on restart (no duplicate side effects).

## Workers

Enroll once (`avity worker enroll <name>` or POST `/v1/workers/enroll`),
store the one-time token in the host's secret store, run:

```sh
AVITY_CONTROL_PLANE_URL=https://plane.example \
AVITY_WORKER_ID=… AVITY_WORKER_TOKEN=… \
node services/worker/dist/main.js
```

Revoke lost hosts immediately: `avity worker revoke <id>` — revoked tokens
are rejected on the next call.

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
