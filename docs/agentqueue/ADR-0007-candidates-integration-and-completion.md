# ADR-0007: Candidates, integration and completion

## Decision

Four things are separate and none is inferred from agent text:

| Concept                      | Who decides                                                                 | Record                                                                                                                                                                                                                           |
| ---------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task implementation finished | The worker handed in a commit and the task's check passed                   | `tasks.status = verifying`, `integration_state = pending`, `candidate_commit`, receipt; the claim is released                                                                                                                    |
| Task completed               | AgentQueue, after the commit is integrated on the plan's integration branch | `tasks.status = completed`, a `landing_queue` row with `status = landed`                                                                                                                                                         |
| Worker settled               | T3 Code, once the worker's turn ended                                       | the thread is settled with `thread.settle`; the lane is free                                                                                                                                                                     |
| Goal completed               | `verifyPlanCompletion`, from the queue and Git only                         | every task completed, none holding a claim or waiting to merge, each landed commit an ancestor of the integration branch, that branch published to the target, and the plan's `Final verification` command passing on the target |

`GOAL COMPLETE`, `BLOCKED TASKS` and `NEEDS ATTENTION` have no authority in a queue goal. A request for a person is honoured
only when no check could show the work is done. A standard (`plan-work`) goal ignores `GOAL COMPLETE` while the repository's plan has
unchecked tasks, a legacy owner, or `agent-plan/<plan>/*` branches the base branch lacks.

## Integration branch and publication

Each plan integrates into its own branch, `agentqueue/goal/<plan>`, which only AgentQueue writes and no checkout ever has open. A
candidate is merged onto that branch's tip in a private detached worktree (`<repo>/.worktrees/agentqueue-staging`, safe to reset), the
task's check is re-run on the merged result, and only then does the branch ref move (compare-and-swap). A task is **completed** when
it is integrated here, which is what unlocks its dependants: workers start from the integration branch, so they already contain every
finished predecessor. The user's checkout is never involved, so uncommitted edits in it cannot block progress.

Updating the target branch (`main`) is **publication**, a separate recorded step (`plans.publication_state`) that runs once every task is
integrated, under the same `flock` `plan-work land` takes. If the target moved independently, it is merged into the integration
branch first and the plan's `Final verification` re-run; a real conflict is `blocked` and goes to the overseer. Then:

- no checkout has the target open: the ref moves;
- a checkout has it open and its edits do not overlap the change: plain fast-forward, edits untouched;
- overlapping edits that are staged, owned by a live process (a process whose working directory is in the checkout), written recently,
  or in the middle of a Git operation: publication stays `pending` with the reason, the verified result stays on the integration
  branch, and the goal stays `running` in the `waiting-publication` phase;
- overlapping plain working-tree edits that are provably idle (no process, older than `AGENTQUEUE_CHECKOUT_IDLE_MINUTES`, default
  30; a modification time alone is never enough): a durable snapshot is taken first (file bytes, the index, a commit of the full working
  state under `refs/agentqueue/snapshots/`, a manifest, all verified), only the overlapping files are moved aside, the branch is
  fast-forwarded, and each edit is merged back on top. A conflicting edit leaves the checkout untouched. The snapshot can restore the
  original state exactly (`restoreSnapshot`).

A merge conflict or a failing merged check on the integration branch becomes `integration_state = conflict`; a repair worker is started
on the existing branch (`repairing`); after the repair budget it becomes `repair_needed` for the overseer. Repair claims are taken
before new work. A goal is **completed** only when every task is integrated, the target branch contains the integration branch, and the
final check passed on the target.

## Restart safety

Chats persist their claim token, branch and worktree. After a restart an interrupted submission is verified again, a candidate that
was already merged is recognised (`merge-base --is-ancestor`) and only recorded, and a claim with no live chat is released without
spending a retry. Work already committed is kept: worktrees and branches are reused, never recreated over existing commits.
