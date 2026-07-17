# Policies and checkpoints

## Policy engine (`packages/policy`)

- Ordered rule evaluation: project policy first, then workspace defaults;
  first matching rule wins. Rules match `action` and `resource` with globs
  (`*` single segment, `**` anything; patterns are escaped — no RegExp
  injection).
- Effects: `allow`, `deny`, `require_approval`.
- **Dangerous-by-construction actions** default to `require_approval` when
  unmatched, regardless of autonomy profile: `git.push_force`,
  `git.merge_protected`, `fs.delete_outside_worktree`, `deploy.production`,
  `infra.provision_paid`, `secret.read`, `policy.override`,
  `worker.revoke`.
- Autonomy profiles set the default for ordinary unmatched actions:
  `supervised` → approval, both autonomous profiles → allow.

## Command and path policy

- `isCommandAllowed` operates on argv arrays only. Ad-hoc human terminals use
  an observation-only policy (`ls`, `echo`, `cat`, `pwd`, `sleep`); shells,
  interpreters and package managers are denied. Mission-bound checks may use
  git/node/package managers only inside their server-resolved worktree and OS
  sandbox.
- `isPathAllowed` confines writes to the mission worktree, minus forbidden
  globs, optionally restricted to allowed globs from the mission contract.

## Budgets

`checkBudget` gates mission starts; crossing the warn fraction emits a
warning, exceeding the limit blocks the mission and opens an approval.
Usage records update `spent_usd` transactionally with the run and event.

## Checkpoints

Kinds: build, lint, typecheck, test, coverage, dependency_scan,
secret_scan, architecture_rule, policy, human_approval. Mission contracts
declare `requiredChecks`; validation records each as a checkpoint row with
status and evidence detail, streamed as `checkpoint.updated` events.

## Decisions are evidence

Every policy decision on the terminal path emits a `policy.decision` event;
denials also append to the hash-chained audit log. Approvals record who
decided, what, and when, and resume or cancel the mission accordingly.
