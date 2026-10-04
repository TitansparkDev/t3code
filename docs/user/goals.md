# Goals

A goal keeps several agents working on one job until nothing is left. Use it for work
that is bigger than one chat, such as "finish everything in PLAN.md", while you are
away.

## Start a goal

On the new-chat project picker (the **New thread in…** menu on desktop and web, the
**Choose project** sheet on mobile), switch **Goal** on, then choose a project. Goal
is off by default each time. You land on the goal setup page, where you choose:

- **Goal** — what should be done. The same text is the goal's name and what every
  agent receives. The first line is the title shown in lists.
- **Agents at once** — how many chats work at the same time (up to 16).
- **Most agents in total** — how many chats the goal may start, or **Until complete**
  to keep going until an agent says nothing is left. With no limit, the goal uses your
  plan's usage until it completes or you stop it.
- **Models** — one or more provider accounts and models, each with its effort level
  and how many of that model run at once. Chats are spread across the models by those
  counts, and never exceed **Agents at once** in total.
- **Other settings** — restart agents cut off by a usage limit (on by default),
  the working rules (on by default), and the permission mode.

The working rules tell each agent to claim one unfinished chunk so others skip it,
work in its own git worktree, merge to the default branch and push when verified, then
remove the worktree. Turn them off for goals that are not code in a shared repository.
Every agent is also told to work alone, use best judgment instead of asking, and stop
after one piece of work. Because agents run unattended, choose a permission mode that
does not wait for approvals; any approval an agent asks for waits for you.

Every goal chat is a new ordinary thread in the project, so mobile shows the working
agents in the thread list.

## What happens next

Each time an agent finishes, the next one starts in its place. When an agent replies
`GOAL COMPLETE` on its own line because nothing is left, the goal is complete and no
more chats start; agents still working finish on their own.

A chat is archived (tidied out of your thread list) only when it finished its work
successfully. A chat that needs you stays where you can see it:

- A chat that fails or is stopped stays open. Its lane is not refilled, so a broken
  setup cannot burn through usage. If every lane is blocked, the goal stops early.
- An agent that is truly stuck, or needs something only you can do (a login, a
  decision), replies `NEEDS ATTENTION` on its own line. The chat stays open, is marked
  **needs you** on the Goals page, and its lane stays closed until you deal with it. An
  approval or question an agent is waiting on also keeps its chat open and working.
- A chat that stops on a usage limit stays open and is resumed when the limit resets,
  and the goal waits for it. It is archived only if the resumed work finishes
  successfully. Without that setting, the chat waits for you to resume it.

## Check on goals

Open **Goals** in the desktop or web sidebar. Each goal shows its progress, a green
tick once it is complete, and a link to each chat. **Stop** interrupts the running
chats. **Start again** starts a stopped, finished, or failed goal with a fresh budget,
and the delete button removes it from the list.
