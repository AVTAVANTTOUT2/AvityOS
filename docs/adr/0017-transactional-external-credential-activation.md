# ADR-0017 — Transactional external-credential activation

Status: accepted for chantier 7 checkpoint 4.

## Context

ADR-0014 made encrypted credential updates atomic, but activating an updated
provider or GitHub credential still required a separate manual service
restart. If the new configuration prevented the control plane from becoming
ready, the operator had to recover the previous secret manually. A blind
rollback could also overwrite a newer concurrent rotation.

AvityOS API and worker bearers are different from vendor credentials: changing
their local vault value without changing the server-side verifier would cut
off the client. They require a dedicated two-phase protocol and cannot safely
share this checkpoint's service-restart workflow.

## Decision

1. `avity vault credential-rotate NAME --stdin` accepts only an existing
   external credential from the closed registry. Credential bytes never enter
   argv, logs, JSON output or error text.
2. The vault exposes a single-entry compare-and-swap primitive. It re-reads
   under the existing owner-only lock, verifies the expected encrypted
   plaintext value, preserves creation metadata and other entries, increments
   the generation, fsyncs and atomically renames.
3. Rotation requires the owning service to be running. After staging the new
   value the CLI restarts only that service, builds a fresh authenticated
   client from the protected environment and performs at most 20 bounded
   probes of health and, when the credential configures a provider, provider
   registration.
4. Failed activation compare-and-swaps the previous value back and performs a
   second restart/probe. If another operator changed the same entry, rollback
   reports a conflict and never overwrites that newer value. If reactivation
   fails, the error remains explicit and fail-closed.
5. `AVITY_API_TOKEN` and `AVITY_WORKER_TOKEN` are rejected by this command.
   Their future rotation must atomically coordinate server and client
   verifiers. `vault set` remains available for initial offline provisioning.
6. A successful activation proves that the scoped value reached a healthy
   service and registered its configured adapter. It deliberately does not
   make a billed vendor request; a real provider mission remains the
   end-to-end credential-acceptance proof.

## Evidence and limits

- Credential-vault tests prove successful compare-and-swap, generation
  changes and preservation of a concurrent newer value.
- Operator tests prove successful activation, rollback plus reactivation after
  a failed probe, conflict-safe failure, exclusion of in-band bearers and
  stdin-only CLI discovery.
- Provider API validity, AvityOS bearer rotation, worker certificate rotation,
  CA rollover and enterprise secret-manager integration remain separate
  checkpoints.
