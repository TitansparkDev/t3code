import type { Goal } from "@t3tools/contracts/goals";

/** One line of progress: agents running, completed, needing you, and how many have started. */
export function describeGoalProgress(
  goal: Pick<Goal, "chats" | "concurrency" | "maxChats">,
): string {
  const running = goal.chats.filter((chat) => chat.status === "running");
  const waiting = running.filter((chat) => chat.waitingForLimit).length;
  const done = goal.chats.filter((chat) => chat.status === "completed").length;
  const failed = goal.chats.filter((chat) => chat.status === "failed").length;
  const attention = goal.chats.filter((chat) => chat.status === "attention").length;
  const stopped = goal.chats.filter((chat) => chat.status === "stopped").length;
  const parts = [
    `${running.length} of ${goal.concurrency} running`,
    `${done} completed`,
    ...(attention > 0 ? [`${attention} need you`] : []),
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(stopped > 0 ? [`${stopped} stopped`] : []),
    ...(waiting > 0 ? [`${waiting} waiting for a usage limit`] : []),
    goal.maxChats === null
      ? `${goal.chats.length} started, until complete`
      : `${goal.chats.length} of up to ${goal.maxChats} started`,
  ];
  return parts.join(" · ");
}

/** The Beads queue at the last check, or undefined when the goal does not use Beads. */
export function describeGoalQueue(goal: Pick<Goal, "queue" | "useBeads">): string | undefined {
  const queue = goal.queue;
  if (!goal.useBeads || !queue) return undefined;
  return `Beads: ${queue.ready} ready · ${queue.working} in progress · ${queue.blocked} blocked · ${queue.done} done`;
}

/**
 * Providers the goal is leaving alone for now, one per entry, with when each comes
 * back. `nameOf` turns a provider instance id into what the person calls it, and
 * `formatTime` turns a time into text in their locale.
 */
export function describeGoalPauses(
  goal: Pick<Goal, "pauses">,
  now: number,
  nameOf: (instanceId: string) => string,
  formatTime: (iso: string) => string,
): ReadonlyArray<string> {
  return (goal.pauses ?? [])
    .filter((pause) => Date.parse(pause.until) > now)
    .map((pause) => {
      const what = pause.reason === "usage-limit" ? "usage limit" : "recent failures";
      const name = pause.model
        ? `${nameOf(pause.instanceId)} ${pause.model}`
        : nameOf(pause.instanceId);
      return `${name} is set aside (${what}) until ${formatTime(pause.until)}`;
    });
}
