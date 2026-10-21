# ADR-0010: One owner per task, shared resources per command, and plans that agents can finish

Status: accepted. Refines ADR-0005, ADR-0007, ADR-0008 and ADR-0009.

## Problem

A task could pass through four or five agent conversations: the implementer, a retry worker, a merge-repair worker, and a repair
for a failed re-check. Each paid for its own context, and a repair worker had to rediscover what the first one knew. Shared tools
(an emulator, Gradle, Docker, a fixed database) were protected either by holding a resource for a worker's whole run, which
starved other tasks, or not at all when a worker ran the tool itself. A busy resource, a file another task held, or a check that
failed for reasons older than the task each cost worker turns or ended in a request for a person. Plans reached workers that could
never finish them (a production apply, a soak, a physical phone).

## Decisions

**A task has one accountable conversation (`taskOwner.ts`, `GoalService.resumeOwner`).** `tasks.owner_ref` is the thread that is
responsible from the first line of code to the verified integration. It is separate from the claim (held only while a worker
runs) and from the candidate (waiting to merge). A merge conflict, a failed retry, a task that waited for a file, a follow-up
repair and the result of a queued command all go back to that thread (`thread.turn.start` on the same thread, with only what is
new). A new conversation takes a task over only when the owner cannot continue: its provider is gone for good, it was resumed too
often, or its thread no longer exists. A provider that is out for a known time is waited for, and other tasks are reserved
meanwhile (`excludeTaskIds`).

**The server does the git work of a repair (`startRepairMerge`).** The integration branch is merged into the owner's own
worktree; generated files and `unionMerge` files are settled by rule; only the real conflict is left in progress for the owner,
who resolves, commits and resubmits. A merge that is clean but fails its checks is handed over already merged. Submit refuses an
unfinished merge or committed conflict markers. The repair budget counts only the same failure against the same integration tip
(`integration_fingerprint`): another task landing is a new situation, not a repeat.

**Resources are taken per command, from one machine-wide queue (`resourceBroker.ts`, `resourceRunner.ts`).** `agentq run --
<cmd>` (workers) and the server's own checks use the same broker: a fair FIFO in `~/.local/share/agentqueue/resources/broker.sqlite`
(passwd home, never `$HOME`), capacities from `~/.config/agentqueue/resources.json`, atomic multi-resource grants, heartbeats and
process-liveness leases, memory admission (`MemAvailable` minus a reserve minus what fresh grants will still claim), and a
head-of-line rule after 30 s so nothing starves. The physical lock is still `agent-resources`' flock slot files (and
`/tmp/android-heavy.lock` for emulator slot 0), so older scripts stay mutually exclusive with it, and a crashed holder never
leaves a stale lock. A task no longer holds a resource for its whole run, and a busy resource never fails a task. A command that
would wait long becomes a stored job (`--defer-after`): the worker ends its turn, the server runs the job when the resource is
free (`createJobRunner`, ticked by the Goal scheduler; a dead runner's job is queued again), and the result goes back into the
same thread. The worker's conversation is parked (`taskOutcome: "waiting"`) and does not occupy a lane meanwhile.

**Capacities are measured, not assumed.** On the 25 GB, 16 vCPU, KVM, no-GPU VM: one headless emulator is 3.2-5.3 GB resident and
two different AVDs run together (8.5 GB); a 2 GB-heap Gradle build needs about 3.5 GB; so `android` 2, `heavy_build` 2,
`docker` 3, `postgres` 6, `gpu` 0. A GPU requirement is therefore held as unavailable, not queued. New workers are also
admitted by memory and load (`hostCapacity.admitWorker`), not by a fixed count.

**Compilers declare their own demand.** `tsc`, `tsgo`, `tsc-rs`, `effect-tsgo` and the repository's `typecheck` script take
`heavy_build` with an 8 GiB demand (`TYPECHECK_DEMAND_MB`): one `apps/server` check measured 4.4 GiB resident on 2026-10-21 and
the incident peaked at 7.5 GiB, so admitting it on the 3.5 GB Gradle estimate was wrong. Identical checks (same source, lock file,
checker versions, environment, command and account) share one process and one receipt (`checkReceipts.ts`,
`scripts/reliability-check.ts`); a claim is taken only after admission, so a waiter never waits on an owner that is queued. A
command started inside a grant its caller holds runs under that grant (`enclosingTicket`) instead of queueing for the same unit.

**Scope is settled by rule (`scopeAudit.decideScope`).** A file outside the declared scope that is not protected and not sensitive
(credentials, CI, live data) is approved automatically and recorded. A file another running task holds parks the task
(`waits_for`), with its commits kept, until that task no longer holds it; this is a temporary constraint, not a dependency.
`agentq task finalize` gives the worker the same decision and the repository finalizer with the real allowed set, so a guard run
earlier never contradicts the server.

**A failure is attributed before anyone repairs it (`baseline.ts`, `audit.ts`).** A check that names failing items outside the
task's own files and that fails the same way on the untouched integration branch is a baseline failure: the task is not made to
repair it, its receipt is `baseline-failed` (never `passed`), and a blocking follow-up task is created. A check that names nothing
(`test -f`, a bare exit code) or names the task's own files is always the task's. When every task has landed, only the checks that
something landed later could have broken (landings touching the task's scope or changed files) are run again, and a failure is
bisected to the first landing that broke it; that task's owner gets the repair. Resource waits during a check are not verdicts: a
submission waits and is tried again, an integration is deferred, no model turn is spent; a resource the machine does not have
holds the task as a prerequisite.

**Plans are linted against the repository (`planLint.ts`, `agentq plan lint [--baseline] [--strict]`).** The planning skill requires
no errors: work only a person or a device can do, production changes outside the one final release task, open decisions, scopes
that leave out the database layer the code imports, protected or missing paths, checks that cannot run here, whole-suite checks,
checks already failing on the starting branch (recorded in `check_baselines`, reused later by attribution), needless dependencies,
overlapping scopes and contradictory instructions.

## Traps

- `startRepairMerge` leaves a merge in progress in the worktree. Anything that commits "pending changes" must skip a worktree with
  unresolved files (`commitPendingChanges` does).
- Baseline attribution is deliberately narrow: a failing item named after the task's own files, or a check that names nothing, is
  never set aside, or a task could pass by not doing its work.
- The broker and the lock files live outside any repository. Tests get a private directory (`VITEST`); a pilot must set
  `AGENTQUEUE_RESOURCE_HOME` and `AGENTQUEUE_LOCK_ROOT` to stay out of the machine's real queue.
- A parked worker's claim is still heartbeaten by the Goal; if it were not, lease recovery would treat the task as abandoned.
