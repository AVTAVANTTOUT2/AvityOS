# AvityOS — product

AvityOS turns a software objective into a verified deliverable with minimal
human intervention, across many isolated projects in parallel.

## The interaction

1. You state an objective (web, macOS app, or `avity objective submit`).
2. AvityOS analyzes it. If something material is ambiguous, it asks **one
   grouped set of questions** — never a drip-feed.
3. You answer once; work resumes automatically.
4. A per-project brain keeps the durable truth: decisions, plan versions,
   mission results, risks — with provenance, never hidden chat memory.
5. Specialized missions execute through interchangeable AI providers,
   validated deterministically (checks, checkpoints, independent review).
6. You are interrupted only for decisions that genuinely require you:
   dangerous actions, budget exhaustion, exhausted correction loops.
7. The deliverable is evidence-backed: runs, checkpoints, events and an
   append-only audit chain — not an AI's claim of completion.

## Surfaces

- **Web** — Mission Control dashboard, projects, missions kanban,
  interventions (answer/approve inline), agents, executions, GitHub & code,
  providers, activity log, settings; cream/indigo Liquid-Glass visual
  identity from the original Figma design. Live/Hors-ligne/Démo/Connexion
  states are always visible; demo fixtures require an explicit build flag.
- **macOS** — native SwiftUI app with Keychain-backed authentication, SSE
  reconnection, projects/missions/runs/terminals, intervention approval,
  deep links, notifications, Dock badge, settings and menu-bar companion.
- **CLI** — `avity` covers the full loop headlessly with `--json` output
  for scripting.

## Quality bar

Quality over speed: missions inside each project are ordered by dependencies,
while separate projects progress concurrently. Completion requires real file
changes, real command exits, a commit/PR record and an independent review.
The fake provider is a deterministic verification fixture, never a claim that
an objective was actually implemented; demo data never masquerades as live.
