# Project lifecycle

Implemented flow (all steps durable, all resumable after restart):

1. **Create project** — API/web/CLI; autonomy profile chosen at creation
   (`supervised`, `autonomous_with_checkpoints`, `maximum_autonomy`).
2. **Submit objective** — free text plus optional acceptance criteria;
   idempotency keys prevent duplicate submission.
3. **Analysis** — the engine checks for material ambiguity (no acceptance
   criteria + very short text, or ambiguity markers). If ambiguous, it asks
   **one grouped clarification** (acceptance criteria + out-of-scope) and
   sets the project to `clarifying`.
4. **Answer once, resume automatically** — answers become durable brain
   `decision` entries with provenance; acceptance criteria are derived from
   the answer; planning restarts with no further prompting.
5. **AI planning pipeline** — a durable asynchronous pipeline builds a
   bounded, secret-free snapshot of the persisted repository, then runs
   analysis → architecture → plan/DAG through a reasoning `ProviderAdapter`
   (editing capability not required). Every step is a durable `brain_runs`
   row with provider, model, redacted input/output and provenance
   (`fake_fixture` output is explicitly labelled). The proposed plan is
   validated deterministically — known acyclic dependencies, full
   acceptance-criteria coverage, valid roles, policy-conformant paths and
   real check commands, budgets/timeouts, no logical duplicates — then
   persisted transactionally as a new plan version with server-minted
   mission ids resolved from the model's logical keys. Invalid output is
   repaired within a bound, then the project is blocked with an
   intervention; a heuristic plan is never silently substituted. Planning
   consumes and enforces the project budget.
6. **Replanning from evidence** — objective revisions and missions that
   fail after their bounded correction loop trigger a bounded, idempotent
   replan that records its trigger, cause and sources, produces a new plan
   version, preserves history, cancels only legally cancellable missions
   and never replaces an in-flight mission (it defers instead).
7. **Scheduling** — unblocked missions (dependency DAG satisfied) promote
   to `ready`; the scheduler starts them within global and per-project
   concurrency limits, priority-ordered, deterministically.
8. **Execution** — a run per attempt through a provider adapter; output,
   usage and artifacts stream into the event log (secrets redacted).
   Provider selection can be routed per role (`AVITY_ROLE_PROVIDERS`). Failures
   go through wait-for-reset → retry → switch model → switch provider →
   escalation (never silently).
9. **Validation** — actual changed paths and required artifacts are checked;
   real commands execute in a worker or fail-closed OS sandbox. Passing exit
   codes become checkpoints. Failure enters the **bounded correction loop**
   (configurable attempts, then escalation to an approval — never
   infinite).
10. **Git + review** — validated changes are committed without repository
   hooks. GitHub projects are pushed and receive an idempotent draft PR.
   A separate reviewer run receives the diff, requirements, project brain and
   check evidence; rejection re-enters bounded correction. Supervised projects
   require a human decision.
11. **Integration & completion** — approved GitHub drafts are marked ready,
    never self-merged. Worktrees are cleaned and durable results enter the
    project brain; the project completes only when every mission is terminal.
12. **Interventions** — blocked missions, budget exhaustion and correction
    limits surface as approvals; approving retries/unblocks, rejecting
    cancels; all decisions are audited.

Test coverage includes lifecycle, grouped clarification, multi-project
isolation, cross-provider fallback, AI planning (real provider calls,
invalid-output repair, fallback, parallel DAG, replanning, restart recovery,
fixture provenance), real fixture-repository edits/checks/commits/reviews,
correction, recovery, cancellation, worker lease fencing and the execution
security boundary.
