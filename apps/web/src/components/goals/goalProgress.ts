import type { Goal } from "@t3tools/contracts/goals";

/** One line of progress: chats working now, chats finished, and the budget. */
export function describeGoalProgress(
  goal: Pick<Goal, "chats" | "concurrency" | "maxChats">,
): string {
  const running = goal.chats.filter((chat) => chat.status === "running");
  const waiting = running.filter((chat) => chat.waitingForLimit).length;
  const done = goal.chats.filter((chat) => chat.status === "completed").length;
  const failed = goal.chats.filter((chat) => chat.status === "failed").length;
  const attention = goal.chats.filter((chat) => chat.status === "attention").length;
  const parts = [
    `${running.length} of ${goal.concurrency} working`,
    `${done} finished`,
    ...(failed > 0 ? [`${failed} failed`] : []),
    ...(attention > 0 ? [`${attention} need you`] : []),
    ...(waiting > 0 ? [`${waiting} waiting for a usage limit`] : []),
    goal.maxChats === null
      ? `${goal.chats.length} started, until complete`
      : `${goal.chats.length} of up to ${goal.maxChats} started`,
  ];
  return parts.join(" · ");
}
