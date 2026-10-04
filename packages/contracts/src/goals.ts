/**
 * Goals — work an environment keeps doing on its own until nothing is left.
 *
 * A person starts one by sending `!goal <what> ...` in any chat. The server
 * keeps several chats working on it at once, starts the next chat as each one
 * finishes, and stops when an agent replies GOAL COMPLETE, the cap is reached,
 * or the person stops it. Every chat is an ordinary thread.
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

/** The message prefix that starts a goal. */
export const GOAL_COMMAND = "!goal";
/** What an agent replies, on its own line, when a goal has no work left. */
export const GOAL_COMPLETE_MARKER = "GOAL COMPLETE";
export const DEFAULT_GOAL_LANES = 3;
export const MAX_GOAL_LANES = 8;
export const DEFAULT_GOAL_MAX_CHATS = 50;

export const GoalStatus = Schema.Literals(["running", "complete", "stopped", "failed"]);
export type GoalStatus = typeof GoalStatus.Type;

export const GoalChatStatus = Schema.Literals(["running", "completed", "failed"]);
export type GoalChatStatus = typeof GoalChatStatus.Type;

export const GoalChat = Schema.Struct({
  threadId: ThreadId,
  status: GoalChatStatus,
  startedAt: IsoDateTime,
  completedAt: Schema.optional(IsoDateTime),
  /** The chat the goal was started from. It is never archived. */
  origin: Schema.optional(Schema.Boolean),
  /** Set while the chat waits for a provider usage limit to reset. */
  waitingForLimit: Schema.optional(Schema.Boolean),
});
export type GoalChat = typeof GoalChat.Type;

export const Goal = Schema.Struct({
  id: GoalId,
  /** Short name, written by the text-generation model from what the person typed. */
  title: TrimmedNonEmptyString,
  /** The person's own words after `!goal`: what should be true when it is done. */
  description: TrimmedNonEmptyString,
  /** The instructions every chat receives, before the standing goal rules. */
  prompt: TrimmedNonEmptyString,
  projectId: ProjectId,
  modelSelection: ModelSelection,
  runtimeMode: RuntimeMode,
  /** How many chats run at once. */
  lanes: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 8 })),
  /** Most chats the goal may start in total. */
  maxChats: Schema.Number.check(Schema.isInt(), Schema.isBetween({ minimum: 1, maximum: 500 })),
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

/** What `!goal` parses into. `lanes` is absent when the message gave none. */
export interface ParsedGoalCommand {
  readonly lanes: number | undefined;
  /** The first line: what the goal is. */
  readonly description: string;
  /** The rest, or the first line again when there is no rest. */
  readonly prompt: string;
}

const GOAL_COMMAND_PATTERN = /^\s*!goal(?:[ \t]+x(\d{1,2}))?(?=\s|$)([\s\S]*)$/iu;

/**
 * `!goal [xN] <what>` then, optionally, more lines of instructions. Returns
 * undefined for anything that does not start with the command, or has nothing
 * after it.
 */
export function parseGoalCommand(text: string): ParsedGoalCommand | undefined {
  const match = GOAL_COMMAND_PATTERN.exec(text);
  if (!match) return undefined;
  const body = (match[2] ?? "").trim();
  if (body.length === 0) return undefined;
  const [firstLine = "", ...rest] = body.split("\n");
  const description = firstLine.trim();
  const instructions = rest.join("\n").trim();
  const lanes = match[1] === undefined ? undefined : Number(match[1]);
  return {
    lanes: lanes === undefined ? undefined : Math.min(MAX_GOAL_LANES, Math.max(1, lanes)),
    description,
    prompt: instructions.length > 0 ? `${description}\n\n${instructions}` : description,
  };
}

/** Whether a message is trying to start a goal, even if it is incomplete. */
export function isGoalCommand(text: string): boolean {
  return /^\s*!goal(?=\s|$)/iu.test(text);
}

const GOAL_COMPLETE_LINE = new RegExp(`^\\s*${GOAL_COMPLETE_MARKER}\\s*$`, "mu");

/** Whether an agent's reply says the goal has no work left. */
export function replyReportsGoalComplete(reply: string | undefined): boolean {
  return reply !== undefined && GOAL_COMPLETE_LINE.test(reply);
}

/**
 * The rules every goal chat receives after the person's instructions. The
 * chats run unattended and alongside each other, so this covers working alone,
 * not colliding, finishing cleanly, and how to say there is nothing left.
 */
export function goalPrompt(goal: Pick<Goal, "prompt" | "lanes">): string {
  return [
    goal.prompt,
    "",
    "--- Goal rules (added automatically) ---",
    `You are one of up to ${goal.lanes} agents working on this goal at the same time, each in its own chat. Nobody is available to answer questions: use your best judgment, choose the safest reasonable option, and say what you chose.`,
    "Find where the work is tracked (for example a plan file in the repository root) and claim one unfinished chunk by marking it with your branch name and committing and pushing that mark, so other agents skip it. If a chunk is already claimed, take another.",
    "Work in your own git worktree on a new branch, never in the shared checkout. Do high-quality work and build and test it before you finish.",
    "When it is verified, rebase on the latest default branch, merge into it, push, then remove your worktree and delete your branch. Leave nothing half-merged.",
    "Then stop. A fresh chat takes the next chunk.",
    `If there is no unfinished work left at all, reply with ${GOAL_COMPLETE_MARKER} on a line by itself.`,
  ].join("\n");
}
