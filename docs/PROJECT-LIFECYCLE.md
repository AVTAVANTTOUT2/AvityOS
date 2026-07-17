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
5. **Plan** — versioned plans; the deterministic planner creates one
   implementation mission per acceptance criterion (role inferred) and links
   them in declared order. Different projects remain parallel; one project
   does not fan out every criterion before prior evidence exists.
6. **Scheduling** — unblocked missions (dependency DAG satisfied) promote
   to `ready`; the scheduler starts them within global and per-project
   concurrency limits, priority-ordered, deterministically.
7. **Execution** — a run per attempt through a provider adapter; output,
   usage and artifacts stream into the event log (secrets redacted).
   Provider selection can be routed per role (`AVITY_ROLE_PROVIDERS`). Failures
   go through wait-for-reset → retry → switch model → switch provider →
   escalation (never silently).
8. **Validation** — actual changed paths and required artifacts are checked;
   real commands execute in a worker or fail-closed OS sandbox. Passing exit
   codes become checkpoints. Failure enters the **bounded correction loop**
   (configurable attempts, then escalation to an approval — never
   infinite).
9. **Git + review** — validated changes are committed without repository
   hooks. GitHub projects are pushed and receive an idempotent draft PR.
   A separate reviewer run receives the diff, requirements, project brain and
   check evidence; rejection re-enters bounded correction. Supervised projects
   require a human decision.
10. **Integration & completion** — approved GitHub drafts are marked ready,
    never self-merged. Worktrees are cleaned and durable results enter the
    project brain; the project completes only when every mission is terminal.
11. **Interventions** — blocked missions, budget exhaustion and correction
    limits surface as approvals; approving retries/unblocks, rejecting
    cancels; all decisions are audited.

Test coverage includes lifecycle, grouped clarification, multi-project
isolation, cross-provider fallback, ordered planning, real fixture-repository
edits/checks/commits/reviews, correction, recovery, cancellation, worker lease
fencing and the execution security boundary.
