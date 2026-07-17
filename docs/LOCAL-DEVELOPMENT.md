# Local development

## Supported versions

- Node **≥ 22.5** (control plane uses built-in `node:sqlite`; developed on 26)
- pnpm 11 (pinned via `packageManager` in package.json)
- macOS 14+ for the SwiftUI app (Xcode 15+)

## Bootstrap

```sh
pnpm install        # one command; native builds (tailwind oxide, esbuild)
                    # are pre-approved in pnpm-workspace.yaml
```

## Run the platform

```sh
pnpm --filter @avityos/control-plane start   # API on 127.0.0.1:7717
pnpm --filter @avityos/web dev               # UI on localhost:5173
pnpm --filter @avityos/worker start          # optional terminal worker
cd apps/macos && swift run AvityOS           # optional native app
```

The web UI badge shows **Live** when connected and **Hors ligne** when the
control plane cannot be reached. Sample fixtures are used only when
`VITE_AVITY_DEMO=1`, with a visible **Démo** badge.

## Verification

```sh
pnpm verify         # build + 99 tests + strict typecheck, every TS package
pnpm verify:full    # above + Playwright E2E + Swift build/test
pnpm licenses:check # 440-package license policy on the current lock install
gitleaks detect --source . --redact
```

## Environment

Copy `.env.example` if you need to override defaults; never commit values.
Useful ones: `AVITY_DB_PATH` (isolate databases per experiment),
`VITE_AVITY_DEMO=1` (force demo mode), `AVITY_API_TOKEN` (require auth).

## Conventions

- ESM everywhere, TypeScript strict (`tsconfig.base.json`), workspace
  protocol for internal deps.
- Tests are colocated `*.test.ts` (vitest); packages build with plain
  `tsc`; tests import built workspace deps — run
  `pnpm --filter <dep> build` after changing a dependency package.
- Never edit an applied SQL migration; append a new one.
