# Goals

A goal keeps several agents working on one job until nothing is left. Use it for work
that is bigger than one chat, such as "finish everything in PLAN.md", while you are
away.

## Start a goal

Choose **New goal** on the Goals page (web and desktop) or in **Settings → Goals** (mobile), then
pick a project. Or, on the new-chat project picker (the **New thread in…** menu on desktop and web, the
**Choose project** sheet on mobile), switch **Goal** on, then choose a project. Goal
is off by default each time. You land on the goal setup page, where you choose:

- **Goal name** — what you are trying to get done. It is the name shown in lists. A new
  goal starts as **Complete the plan**.
- **Instructions for each agent** — what every agent is told. Leave it empty to send
  the goal name. A new goal starts with instructions to claim one ready chunk of the
  active plan through Beads and complete it; edit them freely.
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

Chats are never archived. Each is titled plainly (**Goal worker #3**) and stays in your
thread list; the Goals page shows how each one ended.

- **Safety stop.** If this many finished agents in a row fail, need you, or find only
  blocked work (3 unless you change it), the goal stops starting agents so a plan that
  cannot be finished does not spend your usage overnight. Agents already working are
  left to finish. Fix the problem, then **Start again**.
- **One more try.** The first time an agent replies `NEEDS ATTENTION` or `BLOCKED TASKS`, it
  is asked to figure it out on its own and finish, with permission to go past the chunk's
  edges (fix a broken build, resolve a conflict, re-claim a stale chunk). It is told to
  stay safe (no deleting others' data, no force-pushes, no disabling checks) and to say
  the line again only if a person really is needed. Only if it says so again does it count
  as stuck.
- **Overseer.** Before the goal gives up (the safety stop above, or every Beads chunk
  blocked with nothing working), an overseer reads a briefing: the repository's
  instruction, spec and plan documents, the Beads queue, what is blocked or claimed, and
  how each stuck chat ended. Its answer is the prompt: it is sent to each stuck chat to
  continue it (a decision made, a fix to apply, extra work to do first) and is read first
  by every new agent. It stops the goal and asks you only when nothing an agent can do
  will help, such as a missing login. It runs on Chat Agents when that provider is on,
  otherwise on one of the goal's own models, and is asked at most twice per start. Turn
  it off under **Other settings**.

## Adding agents

**+3 agents** on a goal (Goals page, web and mobile) raises its agents-at-once and most-agents
counts by three, spread over its models, and starts the goal if it was stopped or finished.

## Usage limits and unavailable providers

A usage limit is not a problem with the work, so it never counts toward the safety stop.

- **Providers that are out of usage are skipped.** The goal reads each provider's usage the
  way the usage bars do. A provider whose session or weekly allowance is used up gets no new
  agents until it resets, and the others carry on. A provider that is switched off, not
  installed, or signed out is skipped the same way.
- **A limit hit by an agent sets that provider aside** until the time the provider gives for
  the reset, or for a few minutes to an hour when it gives none. An agent that hit the limit
  before doing anything is dropped, and another provider takes its place. One that had
  started is kept and resumed when the limit resets (with auto resume on), and does not hold
  one of the **Agents at once** lanes while it waits.
- **A provider whose agents fail** is set aside for 5 minutes, then longer if it keeps
  failing, and the goal uses the others.
- **When every provider is unavailable the goal waits** instead of ending, says so on its
  card with the next time to check, and starts again by itself. **Start again** forgets all
  of this and tries immediately.
- An agent you stop yourself is not a failure either.

## Beads

If the project uses [Beads](https://github.com/steveyegge/beads) (it has a `.beads`
folder), leave **Take work from Beads** on. The goal then asks Beads which chunks are
ready and starts one agent per ready chunk, up to **Agents at once**, handing each its
chunk. When an agent closes its chunk and that unblocks others, more agents start. With
nothing ready the goal waits for working agents, and it completes when Beads has no
unfinished chunks left. If nothing is ready or working but chunks remain, it stops
and says it is stalled. Optionally limit it to one epic or plan. A project without Beads
runs plain agents instead.

## Drafts

A new goal you start filling in is saved as a **draft** after a second, so leaving the page
(or closing the app) loses nothing. Drafts show on the Goals page; open one with the pencil to
carry on, then **Start goal**. **Start** on the card starts it as it is. Delete removes it.

## Check on goals

Open **Goals** in the desktop or web sidebar, or **Settings → Goals** on mobile. Each goal shows how many agents are
running, completed, and need you, a green tick once it is complete, the Beads queue,
and a link to any chat that failed or needs you. Working and finished agents are only
counted.

- **Edit** (the pencil) changes any setting, including the instructions, and applies it
  to agents started from then on. Agents already working keep what they were given.
- **Stop** stops starting new agents. Agents already working are not interrupted.
- **Start again** starts a stopped, finished, or failed goal with a fresh budget. In the edit
  form, **Save and start** does both at once.
- A goal that cannot start anything yet says why on its card, and which providers are set aside
  until when.
- The delete button removes the goal from the list; its chats stay as ordinary threads.
