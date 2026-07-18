# Definition-of-done traceability

Evidence date: 2026-07-18. Status: ✅ implemented and locally reproduced ·
🟡 implemented/partial with the exact remaining proof or limitation stated.

| Requirement | Status | Reproducible evidence / limitation |
| --- | --- | --- |
| Complete project onboarding | ✅ | Public create/configuration/PATCH API; normalized objectives and budgets; server-side realpath, Git worktree, local branch and configured GitHub remote validation; Web create/edit/read-only configuration; equivalent CLI create/update/show options. Dedicated contract, control-plane, Web and CLI tests cover valid/no-repo creation, invalid paths, branch/remote validation, idempotent clarification retries, safe queued-plan supersession, in-flight revision conflicts, explicit empty-objective rejection, budget enforcement, homonymous isolation and real UI payload transmission. Local full gates passed; PR #30 passed [CI Linux #20](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29651872643) and [CI macOS #56](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29651872670). |
| Real web state, auth and browser behavior | 🟡 | Typed REST/SSE DataProvider, HttpOnly login, explicit offline/demo separation. `App.tsx` is split into `app/screens/*` and `app/components/*`; the stable control-plane project ID flows from cards and the ⌘K palette into a per-project detail, whose missions, agents, plan and PRs are filtered by ID (including homonymous-project coverage); terminal sessions are modeled per terminal with their own logs; legal mission cancellation, terminal cancellation and intervention choices call real endpoints. Complete onboarding create/edit/read-only state is wired to the public API; Playwright captures the actual multi-field browser payload. Pause/resume stays explicitly disabled because the control plane cannot yet suspend the active provider run atomically. 27 Vitest + 2 Playwright E2E pass. Remaining: the browser onboarding E2E uses an intercepted API boundary while repository validation is proven in the real control-plane suite; settings sections beyond GitHub/Providers are placeholders. |
| Native macOS client | 🟡 | Swift build/test pass; Keychain, auth, SSE reconnect, terminal logs, deep links, notifications, Dock badge, settings/menu bar. Remaining: UI tests and signed/notarized `.app` packaging. |
| `avity` CLI | ✅ | 8 integration tests against an in-process authenticated control plane, including complete repository onboarding and idempotent update. |
| Durable/recoverable control plane | ✅ | SQLite migrations/event log; restart reconciliation scenario; idempotent clean-tree commits and unique PR row per mission. Vendor calls may be retried after a crash and are not exactly-once without vendor support. |
| Multiple isolated projects | ✅ | Scenario 3 proves concurrent project/event/usage isolation; generated missions are ordered within each project. |
| Per-project durable brain | ✅ | Decisions/results/risks with provenance persist and are injected into author and reviewer prompts; dedicated prompt test. |
| Central AI brain (chantier 2) | 🟡 | Durable async pipeline objective → bounded secret-free repo snapshot → structured analysis → architecture → validated plan/DAG → role delegation, entirely through `ProviderAdapter` with strict Zod output, bounded repair, provider fallback, planning budget enforcement and explicit `fake_fixture` provenance. Ambiguous/infeasible analysis blocks before delegation; every mission uses the exact server-detected checks; snapshot/check discovery rejects escaping symlinks; provider artifacts are redacted before persistence. Evidence-based replanning is bounded, atomically idempotent and withdraws stale approvals while preserving history; inactive-plan approval races are refused; restart recovery reconciles orphan brain runs exactly once. 15 dedicated pipeline tests + 10 plan-validation tests + 3 snapshot tests, plus CLI (`avity brain show`) and Web (BrainPanel) coverage — all offline via the fixture provider. Corrected PR #32 head passed local gates and [CI macOS](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29660850182) / [CI Linux](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29660850199). Remaining for ✅: a live reasoning-provider planning run (operator credentials), deliberately deferred to chantier 4. |
| Provider runtime + fallback | 🟡 | Codex/Claude/Cursor CLI, OpenAI Responses, Anthropic, DeepSeek, trusted generic and fake registered; honest capabilities, role routing and cross-provider test. Optional live API credentials were not used in CI. |
| Worker execution architecture | ✅ | Capability/capacity matching, heartbeat, expiry, lease-token fencing, revocation, HTTPS policy, OS sandbox and cancellation; 12 tests. |
| Worktree → checks → commit → review | ✅ | Fixture repository E2E creates a real branch/worktree, forces a defect, executes checks, corrects, commits, independently reviews and cleans up. |
| Push + GitHub draft PR | 🟡 | Injection-safe push/`gh pr` implementation and idempotent DB record exist. PR #1 proves normal branch publication, but autonomous PR creation by a live AvityOS run still needs a dedicated external fixture repository and credentials. |
| Checkpoints and independent review | ✅ | Required commands pass only on exit evidence; separate reviewer run with diff/brain/evidence; rejection loops and approval tested. |
| Usage, quotas and budgets | ✅ | Transactional usage/budget accounting and budget escalation. Provider-reported cost remains zero unless pricing is configured. |
| Execution security boundary | ✅ | 7 control-plane security tests, 12 worker tests, environment test, Git-hook test and sandbox read/write tests cover the audited boundary. |
| Supply-chain gates | ✅ | Local: zero known vulnerabilities, license policy passes 508 installed packages, Gitleaks passes; CI includes blocking audit/license/Gitleaks and SPDX SBOM. |
| Fake/demo honesty | ✅ | Fake is a deterministic engineering fixture; production backend failure shows `Hors ligne`; fixtures require `VITE_AVITY_DEMO=1`. |
| Full local TS verification | ✅ | `pnpm verify`: all builds/typechecks and 168 tests pass. |
| Browser + Swift verification | ✅ | Current checkout: Playwright 2 passed; `swift test` built the package and passed 1 XCTest. |
| Green GitHub Actions from corrected checkout | ✅ | PR #32 corrected head: [CI macOS](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29660850182) and [CI Linux](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29660850199) pass build, 168 tests, typecheck, Playwright, Swift (macOS), audit, 508-package licence policy, Gitleaks (macOS), SPDX SBOM and artifact upload. |
| No autonomous merge | ✅ | The AvityOS engine only marks approved drafts ready and contains no merge operation; repository integration remains an explicit operator action. |

## Mandatory scenarios

| # | Scenario | Evidence |
| --- | --- | --- |
| 1 | Clear objective → completion | control-plane scenario 1 |
| 2 | Ambiguous objective → grouped answer → resume | scenario 2 |
| 3 | Concurrent projects remain isolated | scenario 3 |
| 4 | Rate-limit fallback, including cross-provider | scenario 4 + cross-provider test |
| 5 | Failed validation/review → bounded correction | scenario 5 + fixture defect/review rejection tests |
| 6 | Restart reconciliation | scenario 6; orphan failed once, mission resumes |
| 7 | Forbidden command/security boundary | control-plane security suite + worker scenario 7 |
| 8 | Cancellation cleans process tree/worktree | scenario 8 + runner process-group test |
