# ADR-0011: Stall recovery, machine failures, and follow-ups that need no commit

Status: accepted (0.0.70). Follows ADR-0007 to ADR-0010.

## What went wrong

A live Goal stopped launching agents with four tasks ready and nine configured slots. The recorded sequence was:

1. **The server's own checks had no Android SDK.** The service runs without a login shell, so a
   Gradle check the server ran (after a submit, after a merge, in an audit) failed with
   `SDK location not found` on every branch. The same check failing on the integration branch was
   read as "an old defect", and a repair follow-up (`NR2-FU1`) was created for code that was fine.
2. **A follow-up with nothing to commit was refused.** The owner reran the check, it passed, and
   there was nothing to change. The server answered "no commit, commit something".
3. **The quiet owner still held the files.** The saved thread completed at 02:55:41, but
   the Goal retained a `running` FU1 chat. Its claim held the database scope needed by the
   four ready tasks. Reservation failures were discarded, and no periodic quiet-chat
   reconciliation corrected the stale record. The retained event history proves the ended
   thread and blocked scopes; it does not prove which transient event/read-model race left
   that record behind.
4. **The Goal was subsequently stopped by the owner.** It must be resumed through the existing
   Goal rather than replaced. No scheduler crash is established by the surviving logs.
   Scheduler/event-stream supervision is defensive protection, not the diagnosed stall cause.

## What changed

- **Toolchain** (`toolchain.ts`). Check runs get `ANDROID_HOME` from the same places a person's
  checkout has (environment, Gradle's `systemProp.android.home`, the checkout's ignored
  `local.properties`, default install folders). `environmentFailureOf` recognises output that says
  the machine cannot run the build at all. It is deliberately narrow: a test that prints
  "permission denied" is a test.
- **Machine failures never become code work.** In `submitCandidate`, `integrateCandidate` and the
  audit, such a failure creates no repair follow-up. Submission holds and integration waits carry
  the toolchain fingerprint and retry when it changes or after ten minutes, without spending a
  worker retry. Audits report environment waiting and check again on a later audit pass.
- **A repair follow-up can resolve without a commit** (`followUpResolution.ts`). When the worker of
  a repair follow-up has no commit, the server runs the follow-up's stored checks on the current
  integration tip in a private worktree (not the shared staging one, so the landing lock is not held
  for minutes). Pass: the follow-up completes with a `task_followup_resolved` event and a receipt
  marked `resolvedWithoutChange`, and a parent that was waiting in `conflict` or `repair_needed`
  merges again. One failure followed by a pass is recorded as `flaky`. A machine failure is held.
  A failure that persists goes back to the worker with the check's output. The worker's word never
  decides anything.
- **A turn end seen after a resume is trusted** (`finishChat(..., { vouched: true })`), and a turn
  that completed after the resume is never "older than the resume".
- **Idle sweep.** A chat recorded `running` whose session is idle, with no background work, for
  longer than ninety seconds is finished from the thread's own state. Leases are renewed for
  active or unconfirmed chats. Unknown liveness and background work keep the lease protected.
  A live process with an expired heartbeat retains its scope until explicit safe reconciliation.
  Usage-limit events also defer while background commands run. Cleanup requires a successful
  release and readable ownership evidence; the queue serializes teardown with claim grants.
  An unreadable Git status preserves the worktree. A replaced claim never authorizes stopping
  an earlier active writer: the new reservation waits without touching that worker.
- **Stall diagnostics.** `reserveNext` returns why each ready task was skipped. The goal shows
  `queueProgress.stall` (`NR3, NR4 waiting for files held by NR1`) instead of "Agents are working",
  also right after "+N agents". After two minutes the scheduler recovers on its own: it finishes
  quiet chats, gives back claims nobody works on, and schedules. It uses the ordinary lane scheduler.
- **Supervision.** The session-event listener and the scheduler restart after a failure; a
  scheduler pass exceeding ten minutes is reported without abandoning its database or subprocess operations.
- **Queue outages.** Three failures in a row no longer fail a goal within seconds: the failures
  must also last three minutes.

## Not changed

- A task still cannot start while another running task holds an overlapping scope. When several
  ready tasks list the same broad directory, they run one after another by design. The stall note
  names the holder; narrowing a plan's scopes is a plan decision.
- `queueProgress.stall` is a field, not a new `phase`, so a record written by this version still
  reads on an older server.
