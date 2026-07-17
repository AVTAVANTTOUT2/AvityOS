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
   implementation mission per acceptance criterion (role inferred), plus an
   **independent review mission depending on all of them** (the author is
   never the sole approver). Replanning bumps the plan version.
6. **Scheduling** — unblocked missions (dependency DAG satisfied) promote
   to `ready`; the scheduler starts them within global and per-project
   concurrency limits, priority-ordered, deterministically.
7. **Execution** — a run per attempt through a provider adapter; output,
   usage and artifacts stream into the event log (secrets redacted).
   Provider failures go through policy-driven fallback: wait-for-reset →
   retry-with-backoff → switch model → escalate (never silently).
8. **Validation** — deterministic checks recorded as checkpoints with
   evidence references; failure enters the **bounded correction loop**
   (configurable attempts, then escalation to an approval — never
   infinite).
9. **Review** — supervised projects create a human approval; autonomous
   profiles use the independent review path.
10. **Integration & completion** — results are recorded in the project
    brain; when every mission is `completed`/`cancelled` the project
    completes.
11. **Interventions** — blocked missions, budget exhaustion and correction
    limits surface as approvals; approving retries/unblocks, rejecting
    cancels; all decisions are audited.

Test coverage: `services/control-plane/src/controlplane.test.ts` exercises
scenarios 1–8 of the mandatory list (lifecycle, clarification resume,
concurrent isolation, rate-limit fallback, correction loop, restart
recovery, illegal transitions, cancellation cleanup) plus the worker's
forbidden-command scenario in `services/worker/src/worker.test.ts`.
