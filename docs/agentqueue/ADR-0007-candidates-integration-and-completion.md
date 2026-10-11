# ADR-0007: Candidates, integration and completion

## Decision

Four things are separate and none is inferred from agent text:

| Concept                      | Who decides                                               | Record                                                                                                                                                                             |
| ---------------------------- | --------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Task implementation finished | The worker handed in a commit and the task's check passed | `tasks.status = verifying`, `integration_state = pending`, `candidate_commit`, receipt; the claim is released                                                                      |
| Task completed               | AgentQueue, after the commit is on the base branch        | `tasks.status = completed`, a `landing_queue` row with `status = landed`                                                                                                           |
| Worker settled               | T3 Code, once the worker's turn ended                     | the thread is settled with `thread.settle`; the lane is free                                                                                                                       |
| Goal completed               | `verifyPlanCompletion`, from the queue and Git only       | every task completed, none holding a claim or waiting to merge, each landed commit an ancestor of the base branch, and the plan's `Final verification` command passing on the base |

`GOAL COMPLETE`, `BLOCKED TASKS` and `NEEDS ATTENTION` have no authority in a queue goal. A request for a person is honoured
only when no check could show the work is done. A standard (`plan-work`) goal ignores `GOAL COMPLETE` while the repository's plan has
unchecked tasks, a legacy owner, or `agent-plan/<plan>/*` branches the base branch lacks.

## Integration

A candidate never goes back to unimplemented work. It merges in a dedicated staging worktree
(`<repo>/.worktrees/agentqueue-staging`, detached, safe to reset because it holds nobody's work): merge the candidate onto the
current base tip, re-run the task's check on the merged result, then move the base branch. The shared checkout is touched only for the
final fast-forward, and only when git can do it without overwriting uncommitted edits: if the checkout has uncommitted edits to a file
the change also touches, the candidate stays `pending` and is retried on every scheduler pass. Nothing in the shared checkout is
reset, stashed or cleaned. A merge conflict or a failing merged check becomes `integration_state = conflict`; a repair worker is
started on the existing branch (`repairing`); after the repair budget it becomes `repair_needed` for the overseer. Repair claims are
taken before new work. Integration holds the same `flock` that `plan-work land` uses, so legacy and queue landings never overlap.

## Restart safety

Chats persist their claim token, branch and worktree. After a restart an interrupted submission is verified again, a candidate that
was already merged is recognised (`merge-base --is-ancestor`) and only recorded, and a claim with no live chat is released without
spending a retry. Work already committed is kept: worktrees and branches are reused, never recreated over existing commits.
