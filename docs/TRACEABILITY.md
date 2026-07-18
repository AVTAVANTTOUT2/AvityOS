# Definition-of-done traceability

Evidence date: 2026-07-17. Status: ✅ implemented and locally reproduced ·
🟡 implemented/partial with the exact remaining proof or limitation stated.

| Requirement | Status | Reproducible evidence / limitation |
| --- | --- | --- |
| Real web state, auth and browser behavior | 🟡 | Typed REST/SSE DataProvider, HttpOnly login, explicit offline/demo separation. `App.tsx` is split into `app/screens/*` and `app/components/*`; a selected projectId flows from cards and the ⌘K palette into a per-project detail (missions, agents, plan and PRs filtered by project); terminal sessions are modeled per terminal with their own logs; mission pause/resume/cancel, terminal cancel and intervention option choice call real control-plane endpoints, and remaining non-backed controls are explicitly disabled or removed. 19 Vitest + 1 Playwright E2E pass. Remaining: live-mode mutations (mission transition, terminal cancel) exercised only via unit tests and API-level tests, not yet via a browser E2E against a live control plane; settings sections beyond GitHub/Providers are placeholders. |
| Native macOS client | 🟡 | Swift build/test pass; Keychain, auth, SSE reconnect, terminal logs, deep links, notifications, Dock badge, settings/menu bar. Remaining: UI tests and signed/notarized `.app` packaging. |
| `avity` CLI | ✅ | 7 integration tests against an in-process authenticated control plane. |
| Durable/recoverable control plane | ✅ | SQLite migrations/event log; restart reconciliation scenario; idempotent clean-tree commits and unique PR row per mission. Vendor calls may be retried after a crash and are not exactly-once without vendor support. |
| Multiple isolated projects | ✅ | Scenario 3 proves concurrent project/event/usage isolation; generated missions are ordered within each project. |
| Per-project durable brain | ✅ | Decisions/results/risks with provenance persist and are injected into author and reviewer prompts; dedicated prompt test. |
| Provider runtime + fallback | 🟡 | Codex/Claude/Cursor CLI, OpenAI Responses, Anthropic, DeepSeek, trusted generic and fake registered; honest capabilities, role routing and cross-provider test. Optional live API credentials were not used in CI. |
| Worker execution architecture | ✅ | Capability/capacity matching, heartbeat, expiry, lease-token fencing, revocation, HTTPS policy, OS sandbox and cancellation; 12 tests. |
| Worktree → checks → commit → review | ✅ | Fixture repository E2E creates a real branch/worktree, forces a defect, executes checks, corrects, commits, independently reviews and cleans up. |
| Push + GitHub draft PR | 🟡 | Injection-safe push/`gh pr` implementation and idempotent DB record exist. PR #1 proves normal branch publication, but autonomous PR creation by a live AvityOS run still needs a dedicated external fixture repository and credentials. |
| Checkpoints and independent review | ✅ | Required commands pass only on exit evidence; separate reviewer run with diff/brain/evidence; rejection loops and approval tested. |
| Usage, quotas and budgets | ✅ | Transactional usage/budget accounting and budget escalation. Provider-reported cost remains zero unless pricing is configured. |
| Execution security boundary | ✅ | 7 control-plane security tests, 12 worker tests, environment test, Git-hook test and sandbox read/write tests cover the audited boundary. |
| Supply-chain gates | ✅ | Local: zero known vulnerabilities, license policy passes 446 installed packages, Gitleaks passes; CI includes blocking audit/license/Gitleaks and SPDX SBOM. |
| Fake/demo honesty | ✅ | Fake is a deterministic engineering fixture; production backend failure shows `Hors ligne`; fixtures require `VITE_AVITY_DEMO=1`. |
| Full local TS verification | ✅ | `pnpm verify`: all builds/typechecks and 99 tests pass. |
| Browser + Swift verification | ✅ | Playwright: 1 passed. `swift build && swift test`: 1 XCTest passed. |
| Green GitHub Actions from corrected checkout | ✅ | [CI run #3](https://github.com/AVTAVANTTOUT2/AvityOS/actions/runs/29613605767) passed build, 99 tests, typecheck, Playwright, Swift, audit, 446-package licence policy, Gitleaks, SPDX SBOM and artifact upload. |
| No self-merge | ✅ | Engine only marks approved drafts ready; it contains no merge operation. This platform branch remains unmerged. |

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
