# Goals

A goal keeps several agents working on one job until nothing is left. Use it for work
that is bigger than one chat, such as "finish everything in PLAN.md", while you are
away.

## Start a goal

On the new-chat project picker (the **New thread in…** menu on desktop and web, the
**Choose project** sheet on mobile), switch **Goal** on, then choose a project. Goal
is off by default each time. You land on the goal setup page, where you choose:

- **Goal name** — what you are trying to get done. It is the name shown in lists.
- **Instructions for each agent** — what every agent is told. Leave it empty to send
  the goal name.
- **Agents at once** — how many chats work at the same time (up to 100). New chats start 15 seconds
  apart.
- **Most agents in total** — how many chats the goal may start, or **Until complete**
  to keep going until an agent says nothing is left. With no limit, the goal uses your
  plan's usage until it completes or you stop it.
- **Models** — one or more provider accounts and models, each with its effort level
  and how many of that model run at once. Chats are spread across the models by those
  counts, and never exceed **Agents at once** in total.
- **Other settings** — take work from Beads, stop after repeated failures, restart
  agents cut off by a usage limit (on by default), the working rules (on by default),
  and the permission mode.

The working rules tell each agent to claim one unfinished chunk so others skip it,
work in its own git worktree, merge to the default branch and push when verified, then
remove the worktree. Turn them off for goals that are not code in a shared repository.
Every agent is also told to work alone, use best judgment instead of asking, and stop
after one piece of work. Because agents run unattended, choose a permission mode that
does not wait for approvals; any approval an agent asks for waits for you.

Every goal chat is a new ordinary thread in the project, so mobile shows the working
agents in the thread list.

## What happens next

Each time an agent finishes, the next one starts in its place. Agents end their last
message with one of these lines:

- `GOAL COMPLETE` — nothing is left. The goal is complete and no more chats start.
- `BLOCKED TASKS` — work remains, but all of it waits on tasks that are not done yet.
  No replacement starts until another agent finishes real work, so agents do not pile
  up behind the same blocker.
- `NEEDS ATTENTION` — the agent is stuck or needs something only you can do (a login,
  a decision, a merge it could not finish). The chat stays open and is marked **needs
  you**, and its lane stays closed.

A chat is archived (tidied out of your thread list) only when it finished its work
successfully. A chat that fails or is stopped stays open, and so does one waiting on an
approval or question.

- **Safety stop.** If this many finished agents in a row fail, need you, or find only
  blocked work (3 unless you change it), the goal stops starting agents so a plan that
  cannot be finished does not spend your usage overnight. Agents already working are
  left to finish. Fix the problem, then **Start again**.
- A chat that stops on a usage limit stays open and is resumed when the limit resets,
  and the goal waits for it. It is archived only if the resumed work finishes
  successfully. Without that setting, the chat waits for you to resume it.

## Beads

If the project uses [Beads](https://github.com/steveyegge/beads) (it has a `.beads`
folder), leave **Take work from Beads** on. The goal then asks Beads which chunks are
ready and starts one agent per ready chunk, up to **Agents at once**, handing each its
chunk. When an agent closes its chunk and that unblocks others, more agents start. With
nothing ready the goal waits for working agents, and it completes when Beads has no
unfinished chunks left. If nothing is ready or working but chunks remain, it stops
and says it is stalled. Optionally limit it to one epic or plan. A project without Beads
runs plain agents instead.

## Check on goals

Open **Goals** in the desktop or web sidebar, or **Settings → Goals** on mobile. Each goal shows how many agents are
running, completed, and need you, a green tick once it is complete, the Beads queue,
and a link to any chat that failed or needs you. Working and finished agents are only
counted.

- **Edit** (the pencil) changes any setting, including the instructions, and applies it
  to agents started from then on. Agents already working keep what they were given.
- **Stop** stops starting new agents. Agents already working are not interrupted.
- **Start again** starts a stopped, finished, or failed goal with a fresh budget.
- The delete button removes the goal from the list; its chats stay as ordinary threads.
