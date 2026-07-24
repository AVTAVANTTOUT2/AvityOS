# Runbooks

## Live E2E campaign blocked or failed

1. Read the operator runbook: [LIVE-E2E-CAMPAIGN.md](./LIVE-E2E-CAMPAIGN.md).
2. `avity doctor` — host tools, sandbox, provider binaries/auth.
3. `avity provider status` — effective routing, reviewer/fallback gaps.
4. `avity e2e preflight --project <id>` — per-scenario `ready` vs blocked.
5. `avity e2e live prepare --project <id>` — archived report under
   `~/.avity/operator/reports/`; no remote mutation.
6. If `run` fails after confirmation, inspect `avity run logs <run_id>`,
   `avity intervention list`, and service logs (`avity logs --service worker`).

Remember: `ready` ≠ `passed`; never put secrets on the CLI; `fake` is forbidden
in production/campaign evidence paths.

## Control plane won't start

1. `node --version` — must be ≥ 22.5 (`node:sqlite`).
2. Check the DB path is writable; `AVITY_DB_PATH` overrides.
3. Port conflict: `lsof -i :7717`; change `AVITY_PORT`.

## Mission stuck in `blocked`

1. `avity intervention list` — a blocking approval almost certainly exists
   (provider failure, budget, correction limit).
2. `avity intervention answer <apr_id> --decision approved` to retry, or
   `--decision rejected` to cancel the mission.
3. Inspect why: `avity run list --project <id>`, then
   `avity run logs <run_id>`; `GET /v1/events?projectId=` has the full
   fallback trail (`provider.fallback` events).

## Provider rate-limited or down

Nothing to do within policy: the engine waits for reset when the reset fits
the wait budget, retries with backoff, switches models/providers when allowed,
and escalates an approval otherwise. To change behavior, adjust engine config
(`AVITY_MAX_*`, `allowModelSwitch`) and the provider's configured models.

## Worker offline / compromised

- Offline: it reconnects and resumes polling automatically; leased
  terminals it was running are marked by their exit reports — cancel any
  stuck session via `POST /v1/terminals/:id/cancel`.
- Compromised: `avity worker revoke <id>` immediately invalidates its
  token (hash comparison fails on next call). Re-enroll a clean host.

## Durable remote relay

Build and start the durable ciphertext relay on loopback:

```sh
pnpm --filter @avityos/remote-relay build
AVITY_RELAY_ACCESS_TOKEN="<random value of at least 32 characters>" \
  pnpm --filter @avityos/remote-relay start
```

For a remote deployment, place an HTTPS reverse proxy on the same host in front
of the loopback relay and configure clients with that `https://` URL. The relay
binary refuses a non-loopback bind and the client refuses clear HTTP outside
loopback. Keep the relay access token in an environment file readable only by
the service account. Never reuse the control-plane token.

The bearer above is the relay **administrator** credential. Use
`RemoteRelayAdminHttpClient` to register each signed device certificate with a
distinct random device token; devices use only their own token for publish,
poll and ack. The relay rejects administrator-token reuse and messages to an
unknown or revoked recipient. Calling `revokeDevice(accountId, deviceId)`
invalidates it immediately. Re-registering rotates the token and clears
revocation.

The relay database defaults to `~/.avity/relay.sqlite` (`0600`). Back it up
together with the local bridge-state database while the services are stopped.
SQLite preserves ciphertext queues, deduplication, authorization and cursors
across restarts. Never place private keys or raw pairing secrets in either DB;
they belong in Keychain. Generic external handler side effects remain
at-least-once if the process crashes before the handler returns. An offline
device must reconnect within `AVITY_RELAY_TTL_MS` while messages are pending;
an expired pending envelope creates a deliberate fail-closed cursor gap rather
than silently dropping a remote action.

### macOS host mode

1. Run the relay behind HTTPS (or on loopback for development) and retain its
   administrator token separately from the control-plane token.
2. Run the control plane as the same macOS user as the native app. Public
   bridge state defaults to `~/.avity/remote/bridge.sqlite`; override it with
   `AVITY_REMOTE_BRIDGE_DB_PATH` only to a private directory.
3. In AvityOS **Réglages → Pont distant — mode hôte**, enter the relay URL,
   administrator token and host name. The control plane creates or reuses the
   account/device identity, stores private material in Keychain and enrolls the
   host with its own random device bearer.
4. Create a one-time offer, transfer it out of band, paste the encrypted
   request, then transfer the returned encrypted bootstrap. The raw host
   pairing secret is memory-only and expires after five minutes.
5. Revoke a lost device from the same screen. Local processing stops before the
   relay call; retry the operation if the relay was unavailable so both sides
   report `revoked`.

### macOS remote-device mode

1. On the remote Mac, open **Réglages → Cet appareil — mode distant**, paste
   the complete one-time offer and choose the device name.
2. Click **Créer la requête chiffrée**, copy the result back to the host, accept
   it there, then copy the returned bootstrap to the remote Mac.
3. Click **Ouvrir le bootstrap et terminer**. Only after the signed
   certificates, session, expiry and encrypted payload validate does the app
   store its identity and per-device relay bearer in Keychain.
4. Click **Utiliser le relais chiffré**. The toolbar/menu bar show the active
   transport and projects, missions, approvals, runs and terminals refresh
   through the outbound relay. Use **Revenir au control plane local** to switch
   back without deleting either credential.
5. Use **Oublier cet appareil** to delete remote identity/configuration and
   force local mode. Revoking it on the host remains required if the device was
   lost or compromised.

If a relay call fails after an acknowledgement, leave the configuration in
place and retry: the pending cursor is Keychain-durable and the app retries the
same idempotent ack before publishing another request. A certificate-expiry,
signature, replay, Keychain or HTTPS error is fail-closed and shown in the app;
do not clear the configuration until the cause and host revocation state have
been checked.

If the status is `degraded`, inspect the displayed bounded error, verify relay
HTTPS/certificate reachability and confirm that macOS Keychain is unlocked.
Never paste the relay administrator token into a terminal command or pairing
bundle. The relay URL cannot be changed in place: revoke devices and wait for
the explicit reset/migration checkpoint instead of creating split relay state.

## Build, install and release the macOS app

Create the reproducible development/CI artifact from the repository root:

```sh
./scripts/build-macos-app.sh
(
  cd dist/macos
  shasum -a 256 -c AvityOS-macos-universal.zip.sha256
)
```

The command performs a clean Release build, creates a universal
`arm64`/`x86_64` app, signs it ad hoc, verifies its metadata, executable,
signature, URL scheme and architecture set, then tests the ZIP. The result is
appropriate for local development and CI evidence, not public Gatekeeper
distribution.

Install by dragging `AvityOS.app` into Applications. For a scripted install,
pass an explicit existing writable directory:

```sh
./scripts/install-macos-app.sh \
  "$PWD/dist/macos/AvityOS.app" \
  "/Applications"
```

An existing installation is moved to a timestamped backup. The script does not
invoke `sudo`, delete that backup or remove quarantine metadata.

For a public release, first install the operator-owned Developer ID certificate
and create a notarytool Keychain profile outside the repository. Then:

```sh
AVITY_CODESIGN_IDENTITY="Developer ID Application: Example (TEAMID)" \
  ./scripts/build-macos-app.sh
AVITY_NOTARY_PROFILE="avityos-notary" \
  ./scripts/notarize-macos-app.sh \
  "$PWD/dist/macos/AvityOS.app"
```

The second command rejects ad hoc signatures and absent profiles, submits and
waits, staples, validates with stapler and Gatekeeper, then recreates the ZIP
and checksum. If Apple rejects the submission, do not distribute the earlier
archive; inspect the notarytool submission log, correct the signing/runtime
issue and rebuild from a clean checkout.

## Web UI shows "Hors ligne"

The control plane is unreachable from the browser. Check it is running,
`VITE_AVITY_API` points at the right URL, the browser origin is present in
`AVITY_ALLOWED_ORIGINS`, and the API token/session is valid. `Démo` appears
only when `VITE_AVITY_DEMO=1`.

## Restart during active work

Restart the process. The reconciler fails each orphaned run once and routes the
mission through bounded correction. Clean-tree commit checks and unique PR rows
avoid duplicate local Git/DB side effects. A vendor request interrupted before
its result was persisted can be retried and may be billed again; inspect usage.

## Database corruption suspected

Follow BACKUP-RESTORE.md restore, then `PRAGMA integrity_check` and the
audit `chainValid` check.
