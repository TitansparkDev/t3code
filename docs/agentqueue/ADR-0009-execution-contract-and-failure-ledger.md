# ADR-0009: Execution contract, failure ledger and scope audit

Status: accepted. Refines ADR-0005, ADR-0007 and ADR-0008.

## Problem

The 2026-10-11 Overseer run scheduled workers correctly and then lost most of their effort to facts that were knowable before
any worker existed. The repository's checkout guard accepted only `agent/*` and `agent-plan/*`, AgentQueue named branches
`agentqueue/*`, and every worker discovered that after working. A commit hook rebuilt `tree.txt` on every task branch, so it
conflicted at every merge. Workers ran the repository's scope guard against `main` instead of the plan's branch, so other tasks'
merged work counted as theirs. Tests used fixed container names and ports. A task whose real remainder needed production access
was sent a person-shaped question again and again. Each deterministic wall consumed new worker turns, and the notes that
explained it were reduced to "The worker asked for a person."

## Decisions

**The repository states its rules; AgentQueue never assumes them.** `contract.ts` reads `.agentqueue/contract.json` from the target
branch (never from a worker's branch), overlaid by `<git-common-dir>/agentqueue/contract.json`, and infers a start guard and
accepted branch prefixes from the repository's instruction files and guard scripts when nothing is declared. Inference only
_proposes_: `probeBranchPrefix` really runs the guard in a throwaway worktree for each candidate prefix at bind time, and a
repository that rejects every prefix refuses the goal with the guard's own output. Without a guarded repository the prefix stays
`agentqueue/`.

**An assignment is executable before it is dispatched** (`preflight.ts`, called by `reserveNextTask` after the claim and the
worktree exist, before any chat). It checks the worktree (linked, on a branch, owned by exactly this claim), runs the start
guards (renaming the branch to an accepted prefix, keeping its commits, when a branch-sensitive guard rejects it), the tools
the task's checks need (installing them only when the contract carries an `install` command), that every completed dependency's
landed commit is on the branch the worker starts from, and the task's `[tag]` capabilities. A failure holds the task with its
evidence; the reservation continues with the next ready task. A guard fix made on the target branch reaches workers because the
plan's branch is merged forward with it when that merges cleanly (`syncIntegrationBranch`).

**Failures are classified and remembered** (`failures.ts`, `task_failures`). `transient` is retried inside the existing budget.
`configuration`, `prerequisite` and `external` are deterministic: the task is held (`blocked`, `failure_class`,
`unblock_fingerprint`) and no worker is spent. `verification` and `scope` failures are fixable by a worker, but the same failure on
an unchanged commit is held. A held task is released _without spending a retry_ when `environmentFingerprint` changes: contract,
guard scripts as committed, tool availability and capability probes; `external` holds look at capabilities only, so a guard fix
never sends a worker at a production wall. A follow-up that only says "a person was needed" for a wall since lifted is closed
(`task_followup_resolved`), not worked. A manual `unblock` of an `external` hold is refused.

**Scope is audited by the server, strictly, and widened only by rule** (`scopeAudit.ts`). At submit the changed paths are
classified: declared scope, generated files, the contract's supporting paths, tooling artifacts (`ignoredPaths`, also kept out of
commits through the shared exclude file), and approved amendments. Anything else is returned to the worker. A worker may ask for
more with `SCOPE-REQUEST: <paths> — <reason>`; a request is granted only for concrete paths the candidate really changed, with a
real reason, outside `protectedPaths` and outside the scope of any running task. Making an out-of-scope change never grants it.
The contract's `submit` guards (the repository's own scope guard) are run with the effective allowed set and the plan's branch as
trunk, and the same expanded commands are written into the worker's prompt.

**Generated files are rebuilt, not merged.** A merge whose only conflicts are in contract-declared generated files is resolved by
the repository's own generator; `refreshOnLand` rebuilds them once per landed task. Other conflicts become a repair whose worker
starts from the preserved candidate commits (`alignToCandidate` never drops commits), the conflicting files and the commit list.

**Exclusive resources are reserved, and every task has private names.** `resources` in the contract name things two workers cannot
share (a fixed test database, a port, a single emulator); a task whose scope or check commands match holds one for as long as its
worker runs, and server-run checks take the same lock through lock files (cross-process, stale-owner takeover under a takeover
token). Each unfinished task owns a numbered slot (`env_slot`) from which ports, database name, compose project and temp folder
are derived and given to the worker and to every check run.

**Ownership is enforced by the database.** `task_claims` has unique partial indexes on active `worktree_path` and `branch`.
`claimTask` refuses with `WORKTREE_OWNED` before the constraint does. A retried task whose branch already holds commits has its
checks run on them first; passing commits are submitted without a worker.

**Landed is not checked.** `auditUnverifiedTasks` runs the stored checks of merged tasks that have no passing receipt against the
plan's tip before the plan is published; a failure becomes a blocking repair follow-up. Importing the plan again fills in the
missing check of a completed task and never drops a dependency the queue added (follow-ups).

## Traps

- `loadContract` is cached by the tips of the refs it reads; a contract change on an unrelated ref is seen on the next reservation,
  not before.
- A held task keeps its worktree. `refreshUnworkedWorktree` fast-forwards it when it has no work of its own, otherwise a fixed guard
  would still run from the old copy.
- `awaitingEnvironment` is not a failure: the goal stays running with the reason on its detail line and nobody is asked.
