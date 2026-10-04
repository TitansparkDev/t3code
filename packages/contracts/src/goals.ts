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
/**
 * What an agent replies, on its own line, when unfinished work remains but all
 * of it waits on tasks that are not done yet, so another agent would only wait too.
 */
export const GOAL_BLOCKED_MARKER = "BLOCKED TASKS";
/** What an agent replies, on its own line, when it is stuck or needs the person. */
export const GOAL_NEEDS_ATTENTION_MARKER = "NEEDS ATTENTION";
export const DEFAULT_GOAL_CONCURRENCY = 3;
export const MAX_GOAL_CONCURRENCY = 100;
export const MAX_GOAL_AGENT_COUNT = 100;
/** Agents in a row that may fail to finish before the goal stops itself. */
export const DEFAULT_GOAL_STOP_AFTER_PROBLEMS = 3;
export const MAX_GOAL_STOP_AFTER_PROBLEMS = 50;
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
  /** The Beads chunk this chat was handed, when the goal schedules from Beads. */
  beadId: Schema.optional(Schema.String),
  beadTitle: Schema.optional(Schema.String),
  /** The agent found only blocked work, so it did nothing and no replacement should start yet. */
  blockedWork: Schema.optional(Schema.Boolean),
});
export type GoalChat = typeof GoalChat.Type;

/** Everything a person chooses on the setup page. */
export const GoalSettings = Schema.Struct({
  /** What the goal is: its name and description in lists and chat titles. */
  name: TrimmedNonEmptyString,
  /** The instructions every agent receives. Empty or missing uses the name. */
  prompt: Schema.optional(Schema.String),
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
  /**
   * Take work from the project's Beads queue: start an agent only when a chunk is
   * ready, and hand it that chunk. Falls back to plain agents when the project has no Beads.
   */
  useBeads: Schema.optional(Schema.Boolean),
  /** Only chunks under this Beads epic or plan id. Empty means the whole queue. */
  beadsScope: Schema.optional(Schema.String),
  /** Stop starting agents after this many in a row fail to finish. Missing means the default. */
  stopAfterProblems: Schema.optional(PositiveCount(MAX_GOAL_STOP_AFTER_PROBLEMS)),
});
export type GoalSettings = typeof GoalSettings.Type;

/** What the Beads queue looked like at the last check. */
export const GoalQueue = Schema.Struct({
  ready: Schema.Number,
  /** Claimed and being worked on. */
  working: Schema.Number,
  /** Unfinished and waiting on other chunks. */
  blocked: Schema.Number,
  done: Schema.Number,
  checkedAt: IsoDateTime,
});
export type GoalQueue = typeof GoalQueue.Type;

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
  queue: Schema.optional(GoalQueue),
  /** A chat found only blocked work: start nothing new until another chat finishes. */
  holdStarts: Schema.optional(Schema.Boolean),
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

const GOAL_BLOCKED_LINE = new RegExp(`^\\s*${GOAL_BLOCKED_MARKER}\\s*$`, "mu");

/** Whether an agent's reply says the remaining work is all waiting on unfinished tasks. */
export function replyReportsBlockedWork(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_BLOCKED_LINE.test(reply);
}

/** What a chat that ended with this status and flag counts as, for deciding to stop. */
function isProblemChat(chat: Pick<GoalChat, "status" | "blockedWork">): boolean {
  return chat.status === "failed" || chat.status === "attention" || chat.blockedWork === true;
}

/**
 * How many of the most recently finished chats in a row did not finish their
 * work (failed, need the person, or found only blocked work). A goal that keeps
 * hitting this is not going to get anywhere, so it stops instead of spending usage.
 */
export function problemStreak(chats: ReadonlyArray<GoalChat>): number {
  const finished = chats
    .filter((chat) => chat.status !== "running" && chat.completedAt !== undefined)
    .sort((a, b) => Date.parse(b.completedAt ?? "") - Date.parse(a.completedAt ?? ""));
  const firstGood = finished.findIndex((chat) => !isProblemChat(chat));
  return firstGood === -1 ? finished.length : firstGood;
}

/** The instructions every agent in the goal receives, before the rules added to them. */
export function goalInstructions(goal: Pick<Goal, "name" | "prompt">): string {
  return goal.prompt?.trim() || goal.name;
}

/**
 * The prompt every goal chat receives. Chats run unattended, so they are told
 * to work alone and which line to end on when the work cannot go on. The
 * working rules are optional because not every goal is code in a shared
 * repository. When the goal schedules from Beads, the chat is handed one chunk.
 */
export function goalPrompt(
  goal: Pick<Goal, "name" | "prompt" | "concurrency" | "standardRules">,
  bead?: { readonly id: string; readonly title: string },
): string {
  return [
    goalInstructions(goal),
    "",
    "--- Goal rules (added automatically) ---",
    `You are one of up to ${goal.concurrency} agents working on this goal at the same time, each in its own chat. Nobody is available to answer questions: use your best judgment, choose the safest reasonable option, and say what you chose.`,
    ...(bead
      ? [
          `Your chunk is ${bead.id}: ${bead.title}. Do this chunk only. Claim it first with \`agent-work resume ${bead.id}\` (or \`bd update ${bead.id} --claim\` if agent-work is not available); if it cannot be claimed, stop and reply ${GOAL_BLOCKED_MARKER} on a line by itself.`,
          "Work in the worktree your claim creates, build and test your work, then finish it the project's usual way (for example `agent-work finish`, or merge and `bd close`). Close the chunk only when it is merged.",
        ]
      : goal.standardRules
        ? [
            "Find where the work is tracked (for example a plan file in the repository root) and claim one unfinished chunk by marking it with your branch name and committing and pushing that mark, so other agents skip it. If a chunk is already claimed, take another.",
            "Work in your own git worktree on a new branch, never in the shared checkout. Do high-quality work and build and test it before you finish.",
            "When it is verified, rebase on the latest default branch, merge into it, push, then remove your worktree and delete your branch. Leave nothing half-merged.",
          ]
        : []),
    "Finish one piece of work, then stop. A fresh chat takes the next piece.",
    "Do not spend time exploring: if you cannot quickly find unfinished work you can start, do not build, test, or read the whole repository to look harder. End right away with the matching line below.",
    "End your last message with exactly one of these on a line by itself, when it applies:",
    `${GOAL_COMPLETE_MARKER} — there is no unfinished work left at all.`,
    `${GOAL_BLOCKED_MARKER} — unfinished work remains, but every piece waits on tasks that are not done yet or is already taken by another agent.`,
    `${GOAL_NEEDS_ATTENTION_MARKER} — you hit a problem you cannot fix (for example it cannot be merged even after one rebase), or something only a person can do (a login, a decision, a missing secret). Explain it; that chat is kept open for the person to read.`,
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
