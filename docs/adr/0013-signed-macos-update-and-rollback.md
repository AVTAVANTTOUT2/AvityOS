# ADR-0013 — Signed macOS updates and recoverable rollback

Status: accepted for chantier 6 checkpoint 6.

## Context

The universal application bundle and fail-closed Developer ID/notarization
path produce an installable artifact, but a checksum beside a download is not
an update trust policy. An HTTPS or storage compromise must not be able to
replace AvityOS with an unsigned archive, a different Apple identity or an
older vulnerable build. A failed replacement must also be recoverable without
guessing which application copy is trusted.

The repository and pull-request CI intentionally have no Apple credentials.
They therefore need to reproduce the update protocol and rollback mechanics
without representing an ad hoc application as publicly distributable.

## Decision

1. The stable channel is a strict, versioned JSON manifest in
   `@avityos/contracts`. It binds the semantic version, strictly increasing
   build number, minimum macOS version, ten-character Apple Team ID, archive
   HTTPS URL, exact byte count, SHA-256 digest, publication time and HTTPS
   release-notes URL.
2. A release-specific Ed25519 key signs the canonical manifest. The private
   key is an operator secret outside the repository and must be a regular
   `0600` file. The public key is the installed trust anchor; it is not
   downloaded from the update feed. Key rotation requires a separately
   authenticated application release and is deliberately absent from schema
   version 1.
3. The downloader refuses credentials, fragments, redirects, cleartext URLs,
   manifests over 64 KiB and archives over 512 MiB. It verifies the signature
   before downloading the archive, then enforces increasing version/build,
   signed size and signed digest.
4. `scripts/create-macos-update-manifest.sh` accepts only an application and
   matching archive signed by the pinned Developer ID Team ID, with a valid
   stapled notarization ticket and successful Gatekeeper assessment. Ad hoc
   CI artifacts fail closed.
5. `scripts/update-macos-app.sh` requires an already trusted installation,
   downloads into a private temporary directory, extracts under a deny-default
   macOS sandbox, bounds expansion and entry count, and accepts exactly one
   non-symlink `AvityOS.app`. Version, build, minimum OS and Team ID must match
   the signed manifest before the existing atomic installer runs.
6. Every replacement preserves the prior application under the installer's
   timestamped backup name. `scripts/rollback-macos-app.sh` accepts only such a
   backup in the same canonical installation directory, revalidates it and
   atomically activates a staged copy. It retains both the original backup and
   the failed replacement. A public backup is trusted only against an explicit
   pinned Team ID and valid stapled/Gatekeeper evidence.
7. Updates are an explicit operator action in this checkpoint. There is no
   background self-update, silent restart or remote trust-anchor rotation.
   The manifest must be published last, after the immutable archive and
   release notes are reachable.

## Evidence and limits

- Unit tests cover canonical signing, tampering, the wrong trust anchor,
  downgrade/build replay, minimum OS, HTTPS, size bounds and archive digest.
- macOS CI extracts the real universal ZIP inside the sandbox, installs a
  distinct candidate version, refuses an out-of-directory backup, restores the
  original version, retains recovery copies and proves that public manifest
  creation rejects the ad hoc CI bundle.
- A real public update still requires an operator-owned Apple Developer ID
  certificate, Apple notarization access, a separately protected Ed25519
  signing key and an HTTPS publishing origin. CI cannot truthfully certify
  those external credentials.
