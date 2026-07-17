# Definition-of-done traceability

Status keys: ✅ done · 🟡 partial (gap stated) · Evidence = file/test/commit.

| Requirement | Status | Evidence |
| --- | --- | --- |
| Design → maintainable real web app | ✅ | apps/web: DataProvider (src/lib/data.tsx), typed client (src/lib/api.ts), demo fixtures isolated in src/demo; browser-verified live lifecycle |
| Native macOS app builds and connects | ✅ | apps/macos (SwiftUI, `swift build` verified, launch-tested); menu-bar companion, approvals |
| `avity` CLI works | ✅ | apps/cli + 6 integration tests against a real in-process control plane |
| Durable, recoverable control plane | ✅ | services/control-plane; scenario-6 restart-recovery test (no duplicate side effects) |
| Local/remote worker architecture, secured | ✅ | services/worker; hashed one-time tokens, revocation, lease binding, process-group cleanup (7 tests) |
| Multiple projects concurrently isolated | ✅ | scenario-3 test (missions/events/usage/budgets isolation) |
| Objectives/clarifications/plans/missions/memory persisted | ✅ | SQLite migrations v1–v3; brain entries with provenance |
| Provider adapters + automatic fallback | ✅ | packages/providers (fake, command, OpenAI-compatible, Anthropic); decideFallback + scenario-4 test |
| Terminal output streams live | ✅ | terminal lease/output/exit + SSE `terminal.output` events; worker integration test |
| Git worktree/branch/commit/PR flows | 🟡 | packages/git (worktrees, branch naming, conflicts — 4 tests); PR tracking API. Gap: engine does not yet auto-drive repo worktrees per mission or open GitHub PRs (needs GitHub credential) |
| Checkpoints, policies, independent review | ✅ | packages/policy (9 tests); checkpoints table; review mission depends on all impl missions; supervised → human approval |
| Usage, quotas, budgets tracked | ✅ | usage_records/budgets, budget gate → approval; QuotaState contract |
| Security boundaries and secret handling tested | ✅ | scenario-7 test (forbidden command denied + audited); redaction tests; worker auth tests |
| Fake/demo mode demonstrates lifecycle without credentials | ✅ | FakeProviderAdapter; browser-verified; all tests credential-free |
| Critical-path tests and CI pass | ✅ | 59 tests green; .github/workflows/ci.yml |
| No critical screen on hardcoded mock data | ✅ | all screens read useData(); fixtures only behind explicit Démo badge |
| No critical-path placeholder/fake button | 🟡 | Core loop fully wired (create, objective, interventions, activity). Some prototype panels remain presentational in live mode (settings forms, PR diff view shows empty when no data) |
| Reproducible clean-Mac setup documented | ✅ | README + docs/LOCAL-DEVELOPMENT.md (pnpm install / verify verified from scratch) |
| Repository clean | ✅ | git status clean at each commit; .gitignore covers state |
| Final reviewable PR, no self-merge | ✅ | PR opened from feat/avityos-platform (see final report) |

## Mandatory e2e scenarios

| # | Scenario | Test |
| --- | --- | --- |
| 1 | Clear objective → approved completion (fake provider) | controlplane.test.ts "scenario 1" |
| 2 | Ambiguous objective → grouped clarification → auto-resume | "scenario 2" |
| 3 | Two projects concurrently, isolation proven | "scenario 3" |
| 4 | Simulated rate limit → wait/fallback policy | "scenario 4" |
| 5 | Failed validation → bounded correction loop | "scenario 5" (2 tests) |
| 6 | Control-plane restart mid-work, no duplicate side effects | "scenario 6" |
| 7 | Forbidden command denied and audited | worker.test.ts "scenario 7" |
| 8 | Cancel running mission, children cleaned up | controlplane "scenario 8" + runner cancel test |
