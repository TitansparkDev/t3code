# Scheduled tasks

A scheduled task sends the same prompt to one or more provider accounts at fixed times,
every day or on chosen weekdays. It exists for work you want to happen while nobody is
watching — most commonly opening a provider's rolling usage window first thing in the
morning on more than one account.

Open **Settings → Scheduled Tasks**. Each connected environment keeps its own list,
because the environment's machine is what runs the prompt.

For each task you choose:

- **Name** — what the run's thread is called.
- **Prompt** — the message sent at the scheduled time.
- **Project** — the workspace the run happens in. Leave it on **No project** for prompts
  that only need to reach the provider, such as opening a usage window; those runs use
  the environment's "No project" folder.
- **Accounts and models** — one or more configured provider accounts, each with its own
  model. Running the same prompt on two accounts is the point: they are usually two
  different subscriptions.
- **Time and days** — the time is that environment's own clock, not your device's, so a
  task set to 05:00 fires at five in the morning where the server is. Selecting no days
  means every day.
- **Sends per day and Every (hours)** — repeat the prompt later the same day. Starting at
  05:00 with 5 sends every 5 hours sends at 05:00, 10:00, 15:00, 20:00 and 01:00, so
  each send opens the next five-hour window. Repeats that pass midnight still belong to
  the day that started them, and all of them must fit within 24 hours.

## What a run looks like

Each target gets its own ordinary thread with real history. As soon as its turn
finishes, the thread is archived, so scheduled runs do not pile up in your thread list.
Open one from the task's **Run history** to read the answer or continue the
conversation.

A run that needs you still surfaces: while the agent waits for an approval or input,
its thread stays in the list like any blocked thread.

## Missed runs

If the machine is asleep or offline when a task was due, the run fires when the machine
comes back — but only within an hour of the scheduled time. Later than that it is
skipped until the next send, because a prompt meant to open a five-hour window at 05:00
spends that window if it lands at lunchtime.

Use **Run now** in the task's row to fire a task immediately without touching its
schedule. **Run history** in the same row reports what happened, including targets
that failed to start.

Run history distinguishes a completed provider turn from its five-hour quota result.
**Window opened** means a fresh provider reading shows a new reset time after the old
window ended. **Window active** means a fresh reading shows an active window, but the
run cannot prove it opened that window. **Window unverified** means the provider did
not supply a fresh five-hour reading. For Antigravity, choose an explicit Gemini
model to verify the Gemini window; its automatic model choice does not identify
which quota pool the turn used.
