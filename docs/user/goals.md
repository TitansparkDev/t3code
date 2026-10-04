# Goals

A goal keeps several chats working on one job until nothing is left. Use it for work
that is bigger than one chat, such as "finish everything in PLAN.md", while you are
away.

## Start a goal

In any chat inside a project, send a message that starts with `!goal`:

```
!goal finish everything in PLAN.md
Take a large chunk of the plan, claim it, and do high-quality work.
```

The first line says what the goal is. Any lines after it are instructions for the
agents. Add `x4` after `!goal` to run four chats at once; the default is three and the
most is eight. The chat you typed in becomes the first chat. The others are new chats
in the same project, using the same provider, model, and permission mode.

The server adds standing rules to every chat's prompt: work alone and use best
judgment instead of asking, claim one unfinished chunk so others skip it, work in your
own git worktree, merge to the default branch and push when verified, remove the
worktree, then stop. Because chats run unattended, choose a permission mode that does
not wait for approvals.

## What happens next

Each time a chat finishes, the next chat starts in its place, up to 50 chats per
start. When an agent replies `GOAL COMPLETE` on its own line because nothing is left,
the goal is complete and no more chats start; chats still working finish on their own.
Finished chats other than the one you typed in are archived.

- A chat that fails does not restart its lane, so a broken setup cannot burn through
  the budget. If every lane fails, the goal stops early.
- A chat that stops on a usage limit waits for the limit to reset. Switch it on under
  **Settings → Auto-resume** so it continues without you.
- A goal's title is written for you from what you typed.

## Check on goals

Open **Goals** in the sidebar. Each goal shows its progress, a green tick once it is
complete, and a link to each chat. **Stop** interrupts the chats that are running.
**Start again** starts a stopped, finished, or failed goal with a fresh budget, and
the delete button removes it from the list.
