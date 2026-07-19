# Project lifecycle

Implemented flow (all steps durable, all resumable after restart):

1. **Create project** — API/web/CLI; autonomy profile chosen at creation
   (`supervised`, `autonomous_with_checkpoints`, `maximum_autonomy`).
2. **Submit objective** — free text plus optional acceptance criteria;
   idempotency keys prevent duplicate submission. Revising an objective
   marks any still-open clarification group obsolete in the same
   transaction.
3. **Structured clarification (when needed)** — after a bounded repository
   snapshot, the durable brain analysis may conclude that material
   information is missing. The control plane then runs a dedicated
   `clarification` brain step through `ProviderAdapter` (never a direct
   vendor SDK call). The model proposes a Zod-validated group of questions
   (`logicalKey`, category, reason, closed answer type, optional choices,
   required/optional, acceptance criteria / blocked decisions, provider
   provenance, display order). Deterministic policy rejects secrets, API
   keys, passwords, out-of-scope paths, arbitrary shell commands and
   redundant questions. Round and question counts are bounded by policy;
   a clear analysis continues without intervention. All questions of one
   round are persisted as a single clarification group and surface as one
   intervention; provenance `fake_fixture` remains explicit when the
   FakeProvider is used. A short `deterministic_policy` gate may ask for
   criteria when the objective is extremely short and empty of criteria —
   it is never labelled as an AI clarification.
4. **Answer once, resume automatically** — answers are authenticated,
   contract-validated, idempotent and transactional. Missing required
   answers, unknown keys, illegal choices and obsolete groups are refused
   with stable error codes. On success the group is marked answered, brain
   `decision` entries are recorded with user provenance, objective/criteria
   are enriched without erasing history, a durable event is appended, and
   the brain pipeline resumes exactly once (no concurrent plan from the
   same answer).
5. **AI planning pipeline** — a durable asynchronous pipeline builds a
   bounded, secret-free snapshot of the persisted repository, then runs
   analysis → architecture → plan/DAG through a reasoning `ProviderAdapter`
   (editing capability not required). Clarification answers are injected
   into subsequent analysis prompts. Every step is a durable `brain_runs`
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
   concurrency limits, priority-ordered, deterministically. A paused
   project never schedules or starts a new run.
8. **Execution** — a run per attempt through a provider adapter; output,
   usage and artifacts stream into the event log (secrets redacted).
   Provider selection can be routed per role (`AVITY_ROLE_PROVIDERS`). Failures
   go through wait-for-reset → retry → switch model → switch provider →
   escalation (never silently). Late results from revoked leases or fenced
   runs are refused.
9. **Atomic project pause / resume** — pause is a durable, idempotent
   control-plane transaction: the pause request is persisted, the project
   transitions to `paused`, active runs are cancelled, worker leases for the
   project are revoked (fencing tokens invalidate further submissions), and
   an audit event is written in the same transaction. Pause does **not**
   claim to freeze an external provider process in its exact memory; it
   guarantees that after a successful pause the project cannot plan or start
   work, late results cannot integrate, and restart preserves the paused
   state. Resume reactivates the project once, does not replay completed
   missions, and interrupted work continues as a new attempt linked to
   history; old leases never become valid again.
10. **Validation** — actual changed paths and required artifacts are checked;
   real commands execute in a worker or fail-closed OS sandbox. Passing exit
   codes become checkpoints. Failure enters the **bounded correction loop**
   (configurable attempts, then escalation to an approval — never
   infinite).
11. **Git + review** — validated changes are committed without repository
   hooks. GitHub projects are pushed and receive an idempotent draft PR.
   A separate reviewer run receives the diff, requirements, project brain and
   check evidence; rejection re-enters bounded correction. Supervised projects
   require a human decision.
12. **Integration & completion** — approved GitHub drafts are marked ready,
    never self-merged. Worktrees are cleaned and durable results enter the
    project brain; the project completes only when every mission is terminal.
13. **Interventions** — blocked missions, budget exhaustion, clarification
    groups and correction limits surface as approvals; answering a
    clarification, approving retries/unblocks, or rejecting cancels; all
    decisions are audited.

Test coverage includes lifecycle, structured grouped clarification,
atomic pause/resume and fencing races, multi-project isolation,
cross-provider fallback, AI planning (real provider calls, invalid-output
repair, fallback, parallel DAG, replanning, restart recovery, fixture
provenance), real fixture-repository edits/checks/commits/reviews,
correction, recovery, cancellation, worker lease fencing and the execution
security boundary.
