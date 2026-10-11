import type { Goal } from "@t3tools/contracts/goals";

/** One line of progress: agents running, completed, needing you, and how many have started. */
export function describeGoalProgress(
  goal: Pick<Goal, "chats" | "concurrency" | "maxChats">,
): string {
  const submitted = goal.chats.filter((chat) => chat.taskOutcome === "submitted").length;
  const merged = goal.chats.filter((chat) => chat.taskOutcome === "integrated").length;
  const running = goal.chats.filter((chat) => chat.status === "running");
  const waiting = running.filter((chat) => chat.waitingForLimit).length;
  const done = goal.chats.filter((chat) => chat.status === "completed").length;
  const failed = goal.chats.filter((chat) => chat.status === "failed").length;
  const attention = goal.chats.filter((chat) => chat.status === "attention").length;
  const stopped = goal.chats.filter((chat) => chat.status === "stopped").length;
  const parts = [
    `${running.length} of ${goal.concurrency} running`,
    `${done} completed`,
    ...(merged > 0 ? [`${merged} merged`] : []),
    ...(submitted > 0 ? [`${submitted} waiting to merge`] : []),
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

const PHASE_LABEL = {
  implementing: "Agents are working",
  "waiting-dependencies": "Waiting for other tasks to finish before more can start",
  "waiting-integration": "Waiting for finished work to merge",
  "waiting-publication": "Finished and verified; waiting to update the target branch",
  blocked: "Blocked: needs repair or a decision",
  complete: "Complete: every task verified and merged",
  idle: "Idle",
} as const;

/** Which mode the goal runs in and why, as one line. */
export function describeGoalMode(
  goal: Pick<Goal, "agentQueue" | "queueReason" | "queueMode" | "useAgentQueue" | "status">,
): string | undefined {
  if (goal.agentQueue) {
    return `AgentQueue · ${goal.agentQueue.planPath} → ${goal.agentQueue.baseBranch}`;
  }
  if (goal.status === "draft") return undefined;
  return goal.queueReason ? `Standard mode · ${goal.queueReason}` : "Standard mode";
}

/** The task queue at the last check: AgentQueue progress, or the historical Beads counts. */
export function describeGoalQueue(
  goal: Pick<Goal, "queue" | "useBeads" | "agentQueue" | "queueProgress">,
): string | undefined {
  const progress = goal.queueProgress;
  if (goal.agentQueue && progress) {
    return [
      `${progress.completed} of ${progress.total} tasks done`,
      `${progress.running} being worked`,
      ...(progress.awaitingIntegration > 0
        ? [`${progress.awaitingIntegration} waiting to merge`]
        : []),
      ...(progress.needsRepair > 0 ? [`${progress.needsRepair} need repair`] : []),
      `${progress.ready} ready · ${progress.waiting} waiting on others`,
      PHASE_LABEL[progress.phase],
      ...(progress.note ? [progress.note] : []),
    ].join(" · ");
  }
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
