# Initial Repository Audit

Date: 2026-07-17
Auditor: autonomous build (Claude Fable 5)
Commit audited: `7a5f199` ("Update README.md", branch `main`)

## What the repository contained

The repository was a **Figma Make export** of a UI prototype, not an application:

| Item | State |
| --- | --- |
| `src/app/App.tsx` | Single 1,628-line file containing the entire prototype: layout, all screens, and all data |
| `src/app/components/ui/*` | Complete shadcn/ui component kit (48 components, Radix-based) |
| `src/imports/pasted_text/avityos-ui-spec.md` | 724-line UI specification pasted into the Make session |
| `src/styles/*` | Tailwind v4 theme; white/cream + indigo accent, Liquid-Glass-inspired |
| `package.json` | Named `@figma/my-make-file`; only `dev`/`build` scripts |
| `pnpm-workspace.yaml` | Pinned `supportedArchitectures.os: [linux]` — **installation failed on macOS** |
| Tests | None |
| CI | None |
| Backend | None |
| TypeScript config | None (Vite defaults only) |
| `.gitignore` | None |

## Key findings

1. **All data was hardcoded mock data** (French-language sample projects, agents,
   missions, terminals, PRs) defined as constants inside `App.tsx`. Every
   interaction was simulated; no network calls existed anywhere.
2. **The visual identity is high quality and worth preserving**: cream/white
   surfaces, restrained indigo accent, translucent panels, good typography and
   spacing. It is the product UX reference (Figma file `MnTdZbrH4OHTHD8NbZC6iz`).
3. **The prototype demonstrates the intended screens**: Mission Control
   dashboard, projects, agents, terminals, Git/PRs, interventions, quality,
   providers/quotas, settings. These map directly onto the real product's
   feature modules.
4. **Nothing in the repository was reusable as backend architecture.** The
   entire control plane, domain model, persistence, provider integration,
   worker system, CLI, and macOS app had to be designed and built from scratch.
5. `react`/`react-dom` were declared as *optional peer dependencies* (a Make
   artifact); they are direct dependencies in reality.

## Decisions taken from the audit

- Preserve the frontend and its git history; move it to `apps/web` (done via
  `git mv`, see ADR-0001).
- Treat `App.tsx` as a **UX reference to refactor**, not code to keep as-is:
  mock data moves behind an explicit demo mode, screens become feature modules
  wired to real backend state.
- Build the platform as a pnpm monorepo (ADR-0001) with a deterministic
  TypeScript control plane (ADR-0002), SQLite persistence (ADR-0003), zod
  contracts (ADR-0004), and versioned provider adapters (ADR-0005).
