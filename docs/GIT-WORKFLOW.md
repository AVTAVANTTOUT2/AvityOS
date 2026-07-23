# Git workflow

## For missions (product behavior)

`packages/git` provides the injection-safe primitives the engine uses:

- **One isolated worktree + branch per code mission**:
  `addMissionWorktree(repo, path, branch, baseRef)`; branch names are
  predictable and tied to mission ids: `mission/<id>-<slug>`
  (`missionBranchName`).
- **Clean-state discipline**: `isCleanWorkingTree` before and after
  execution; `changedFiles(base, branch)` enforces the mission's path
  scope.
- **Conflict detection**: `hasConflicts` dry-runs a merge with
  `git merge-tree --write-tree` — no working-tree mutation.
- **No shell or untrusted hooks**: every call is argv-based with a scoped
  environment; automated commits use `--no-verify` after explicit checks.
- Completed/abandoned worktrees are removed with `removeWorktree`.
- Validated changes are committed, pushed to the configured GitHub remote and
  create/update one draft PR per mission through non-interactive `gh`. After
  independent review, AvityOS retains the draft for an explicit operator
  decision and never marks it ready or merges it autonomously.

Direct pushes to protected branches and force pushes are dangerous actions
in the policy engine (approval required by default). Opening real GitHub PRs
requires authenticated `git`/`gh`; failure blocks the mission and creates an
intervention rather than silently completing.

## For this repository (build discipline)

- Work happens on `feat/avityos-platform`; `main` is never rewritten.
- Small conventional commits (`feat(scope):`, `refactor:`, `docs:`,
  `chore:`, `ci:`), each leaving the repo buildable.
- The Figma-derived frontend history is preserved (moved with `git mv`).
- CI (build, 99 tests, typecheck, Playwright, Swift, audit, licences,
  Gitleaks and SBOM) runs on every PR.
- The platform PR is opened for review and **not self-merged**.
