# ADR-0008: Verification contract and worker settlement

Status: accepted. Refines ADR-0007.

## Problem

Production run v0.0.65 showed three connected failures: a worker was settled the moment its model turn ended (which stops its
session and kills the background tests it was waiting on), no task had a runnable check (the plan's `Done:` prose was parsed as
"no command", and "no command" counted as a pass), and a worker's closing text could decide a task's disposition.

## Decisions

**A worker is finished only when it is quiet.** Quiet means no running or starting model turn _and_ no live background work
(`ThreadBackgroundLivenessService`). A turn that ends with background commands running is a pause: the chat stays `running`, the
scheduler tick looks again, and a wake-up turn is handled like any other. After three hours the session is stopped explicitly; the
work is then judged by its commits and checks, never by the turn having ended. Submission re-checks quietness before it runs a
check. A worktree has one writer: before a new worker starts in a worktree, earlier workers still running there are stopped.

**Every task has a verification definition, stored as `tasks.verification_spec`** (migration 4): one of declared checks, derived
checks, an exemption with a reason, or nothing. Declared checks come from `Checks:` bullets (`cwd`, `timeout`, `requires`,
`expect`) or a single `Verify:` span. Derived checks are runner-like code spans of a prose `Done:` line that pass the same policy;
their directory is inferred from the project files and the task's scope, or the check is rejected. The policy
(`inspectCheckCommand`) allows plain test, lint and build runners only and refuses deployment, network, other hosts, deletion,
repository changes, paths outside the worktree and secrets on the command line; refused commands are listed on the task.
`runSpec` is the only executor: it runs checks in order in their directory, in their own process group, asynchronously, with the
timeout enforced, holding any `requires` resource exclusively. A check that did not finish is a failure. The first failure
stops the rest and its exact result (command, directory, exit code, signal, output tails) is recorded as a `task_verification_failed`
event; a passing run is stored in the candidate's receipt.

**Nothing silent counts as a pass.** A task with no definition is `unverified`: it may merge, but its receipt says so, it is listed
as `unchecked` by `verifyPlanCompletion`, and the plan is not complete until a later audit (`task_audited` event with state
`passed` or `exempt`) or an explicit definition covers it. An exemption is recorded as `exempt`, never `passed`.

**Worker text never decides a task.** Submission reads the task's commits and checks. A `NEEDS ATTENTION` request is kept as a note.
If the worker committed, the work is checked and merged, and the request becomes a follow-up task. The follow-up is _blocking_
unless the task's own declared checks passed: a blocking follow-up is added to the dependencies of every task that waited on the
parent and has not started, so nothing builds on an unfinished requirement. The plan cannot complete while any follow-up is open.
With nothing committed the task is parked for a person.

**Teardown follows safety, not speed.** A landed task's worktree is removed only when no claim, turn or background job uses it,
the last turn's checkpoint is saved (or has failed on record), and nothing is uncommitted. A sweep retries on every tick, also for
finished goals. Checkpoint refs live in the repository's shared ref store, so the diff of a thread whose worktree is gone is read
from the project repository.
