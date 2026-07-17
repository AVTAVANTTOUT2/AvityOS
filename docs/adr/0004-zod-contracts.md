# ADR-0004: zod schemas in packages/contracts as the single source of truth

Status: accepted
Date: 2026-07-17

## Context

Web, macOS, CLI and services must observe the same canonical state. Contracts
must be versioned, runtime-validated (all external input is untrusted), and
usable to generate OpenAPI documentation.

## Decision

- Every domain entity, API request/response, and event payload is a zod schema
  in `packages/contracts`. TypeScript types are inferred, never hand-written
  next to the schema.
- Schemas carry a `schemaVersion` where they cross process boundaries (events,
  worker leases, provider adapter I/O).
- The control plane validates all inbound bodies/params with these schemas and
  serves an OpenAPI document derived from them.
- Enumerations (mission states, error categories, event types) are defined
  once here and imported by the orchestration engine and the UI.
- The macOS client consumes the same wire format via Codable structs kept in
  sync with the OpenAPI document.

## Consequences

- A contract change is a reviewable diff in one package.
- Runtime validation at every boundary is uniform.
- Breaking changes require a version bump and a documented migration.
