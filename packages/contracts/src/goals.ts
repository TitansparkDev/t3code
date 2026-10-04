/**
 * Goals — work an environment keeps doing on its own until nothing is left.
 *
 * A person sets one up from the new-chat flow with the Goal switch on: what
 * the goal is, how many agents run at once, which providers, models and effort
 * levels to use and how many of each, and when to stop. The server keeps that
 * many chats working, starts the next chat as each one finishes, and stops
 * when an agent replies GOAL COMPLETE, the cap is reached, or the person
 * stops it. Every chat is an ordinary thread.
 *
 * Fork-local, in its own file so it does not conflict with upstream edits.
 *
 * @module goals
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, ProjectId, ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ModelSelection, RuntimeMode } from "./orchestration.ts";

export const GoalId = Schema.String.pipe(Schema.brand("GoalId"));
export type GoalId = typeof GoalId.Type;

/** What an agent replies, on its own line, when a goal has no work left. */
export const GOAL_COMPLETE_MARKER = "GOAL COMPLETE";
/** What an agent replies, on its own line, when it is stuck or needs the person. */
export const GOAL_NEEDS_ATTENTION_MARKER = "NEEDS ATTENTION";
export const DEFAULT_GOAL_CONCURRENCY = 3;
export const MAX_GOAL_CONCURRENCY = 16;
export const MAX_GOAL_AGENT_COUNT = 16;
export const DEFAULT_GOAL_MAX_CHATS = 50;
export const MAX_GOAL_MAX_CHATS = 10_000;

export const GoalStatus = Schema.Literals(["running", "complete", "stopped", "failed"]);
export type GoalStatus = typeof GoalStatus.Type;

export const GoalChatStatus = Schema.Literals(["running", "completed", "failed", "attention"]);
export type GoalChatStatus = typeof GoalChatStatus.Type;

const PositiveCount = (maximum: number) =>
  Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum }));

/** One provider, model and effort level, and how many of its chats may run at once. */
export const GoalAgent = Schema.Struct({
  modelSelection: ModelSelection,
  count: PositiveCount(MAX_GOAL_AGENT_COUNT),
});
export type GoalAgent = typeof GoalAgent.Type;

export const GoalChat = Schema.Struct({
  threadId: ThreadId,
  /** Index into the goal's `agents` that this chat runs on. */
  agentIndex: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  status: GoalChatStatus,
  startedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  /** Set while the chat waits for a provider usage limit to reset. */
  waitingForLimit: Schema.optional(Schema.Boolean),
});
export type GoalChat = typeof GoalChat.Type;

/** Everything a person chooses on the setup page. */
export const GoalSettings = Schema.Struct({
  /** What the goal is. Also the instructions every chat receives. */
  name: TrimmedNonEmptyString,
  projectId: ProjectId,
  agents: Schema.Array(GoalAgent).check(Schema.isMinLength(1)),
  /** Most chats working at the same time, across all agents. */
  concurrency: PositiveCount(MAX_GOAL_CONCURRENCY),
  /** Most chats to start in total. Null keeps going until an agent says it is complete. */
  maxChats: Schema.NullOr(PositiveCount(MAX_GOAL_MAX_CHATS)),
  runtimeMode: RuntimeMode,
  /** Resume chats that stop on a usage limit when it resets, so the work gets finished. */
  autoResume: Schema.Boolean,
  /** Add the working rules: claim a chunk, own worktree, merge, push, clean up. */
  standardRules: Schema.Boolean,
});
export type GoalSettings = typeof GoalSettings.Type;

export const Goal = Schema.Struct({
  ...GoalSettings.fields,
  id: GoalId,
  status: GoalStatus,
  detail: Schema.optional(TrimmedNonEmptyString),
  createdAt: IsoDateTime,
  updatedAt: IsoDateTime,
  /** Set when the goal is started again; chats and failures before it no longer count. */
  restartedAt: Schema.optional(IsoDateTime),
  completedAt: Schema.optional(IsoDateTime),
  chats: Schema.Array(GoalChat),
});
export type Goal = typeof Goal.Type;

export const GoalList = Schema.Struct({ goals: Schema.Array(Goal) });
export type GoalList = typeof GoalList.Type;

/** The first line of a goal's name, for lists and chat titles. */
export function goalTitle(goal: Pick<Goal, "name">): string {
  const firstLine = goal.name.split("\n", 1)[0]?.trim() ?? "";
  return firstLine.length > 80 ? `${firstLine.slice(0, 79)}…` : firstLine;
}

const GOAL_COMPLETE_LINE = new RegExp(`^\\s*${GOAL_COMPLETE_MARKER}\\s*$`, "mu");
const GOAL_NEEDS_ATTENTION_LINE = new RegExp(`^\\s*${GOAL_NEEDS_ATTENTION_MARKER}\\s*$`, "mu");

/** Whether an agent's reply says the goal has no work left. */
export function replyReportsGoalComplete(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_COMPLETE_LINE.test(reply);
}

/** Whether an agent's reply says it is blocked or needs the person to do something. */
export function replyNeedsAttention(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_NEEDS_ATTENTION_LINE.test(reply);
}

/**
 * The prompt every goal chat receives. Chats run unattended, so they are told
 * to work alone and how to say there is nothing left. The working rules are
 * optional because not every goal is code in a shared repository.
 */
export function goalPrompt(goal: Pick<Goal, "name" | "concurrency" | "standardRules">): string {
  return [
    goal.name,
    "",
    "--- Goal rules (added automatically) ---",
    `You are one of up to ${goal.concurrency} agents working on this goal at the same time, each in its own chat. Nobody is available to answer questions: use your best judgment, choose the safest reasonable option, and say what you chose.`,
    `Only if you are truly blocked, hit a problem you cannot fix, or something can only be done by a person (a login, a decision, a missing secret), explain it and reply with ${GOAL_NEEDS_ATTENTION_MARKER} on a line by itself. That chat is then kept open for the person to read.`,
    ...(goal.standardRules
      ? [
          "Find where the work is tracked (for example a plan file in the repository root) and claim one unfinished chunk by marking it with your branch name and committing and pushing that mark, so other agents skip it. If a chunk is already claimed, take another.",
          "Work in your own git worktree on a new branch, never in the shared checkout. Do high-quality work and build and test it before you finish.",
          "When it is verified, rebase on the latest default branch, merge into it, push, then remove your worktree and delete your branch. Leave nothing half-merged.",
        ]
      : []),
    "Finish one piece of work, then stop. A fresh chat takes the next piece.",
    `If there is no unfinished work left at all, reply with ${GOAL_COMPLETE_MARKER} on a line by itself.`,
  ].join("\n");
}

/**
 * Why a setup is not ready to start, or undefined when it is. Shared by the
 * setup pages so web and mobile accept the same input as the server.
 */
export function goalSettingsProblem(
  settings: Pick<GoalSettings, "name" | "agents" | "concurrency" | "maxChats">,
): string | undefined {
  if (settings.name.trim().length === 0) return "Write what the goal is.";
  if (settings.agents.length === 0) return "Choose at least one model.";
  if (settings.maxChats !== null && settings.maxChats < settings.concurrency) {
    return "The most chats to run must be at least as many as run at once, or choose until complete.";
  }
  return undefined;
}
