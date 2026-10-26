/**
 * MCP input and output shapes for Goal tools (`t3_goal_*`). The tools call the
 * same GoalService methods as the WebSocket RPCs in goals.ts; these shapes are
 * smaller so an outside agent can read a goal without its whole chat history.
 *
 * @module goalsMcp
 */
import * as Schema from "effect/Schema";

import { ProjectId, TrimmedNonEmptyString } from "./baseSchemas.ts";
import {
  Goal,
  GoalAgent,
  GoalChat,
  GoalChatStatus,
  GoalId,
  GoalSettings,
  GoalStatus,
  MAX_GOAL_AGENT_COUNT,
} from "./goals.ts";

const settings = GoalSettings.fields;

/** Every setting an agent may change. Project and history fields are not editable here. */
const GoalMcpEditableFields = {
  name: Schema.optional(TrimmedNonEmptyString),
  prompt: settings.prompt,
  agents: Schema.optional(Schema.Array(GoalAgent).check(Schema.isMinLength(1))),
  concurrency: Schema.optional(settings.concurrency),
  maxChats: Schema.optional(settings.maxChats),
  runtimeMode: Schema.optional(settings.runtimeMode),
  autoResume: Schema.optional(settings.autoResume),
  standardRules: Schema.optional(settings.standardRules),
  stopAfterProblems: Schema.optional(settings.stopAfterProblems),
  overseer: Schema.optional(settings.overseer),
  overseerAgents: settings.overseerAgents,
  queueMode: Schema.optional(settings.queueMode),
  planPath: Schema.optional(settings.planPath),
  checkoutPolicy: Schema.optional(settings.checkoutPolicy),
};

export const GoalCreateMcpInput = Schema.Struct({
  ...GoalMcpEditableFields,
  name: TrimmedNonEmptyString,
  projectId: ProjectId,
  agents: Schema.Array(GoalAgent).check(Schema.isMinLength(1)),
  /** Start the goal now. Omitted or false saves a draft that runs nothing until started. */
  start: Schema.optional(Schema.Boolean),
  /**
   * A repeat call with the same value returns the goal the first call created instead of
   * creating another. Remembered only while the server runs.
   */
  clientRequestId: Schema.optional(TrimmedNonEmptyString.check(Schema.isMaxLength(200))),
});
export type GoalCreateMcpInput = typeof GoalCreateMcpInput.Type;

export const GoalUpdateMcpInput = Schema.Struct({
  goalId: GoalId,
  ...GoalMcpEditableFields,
});
export type GoalUpdateMcpInput = typeof GoalUpdateMcpInput.Type;

export const GoalIdMcpInput = Schema.Struct({ goalId: GoalId });
export type GoalIdMcpInput = typeof GoalIdMcpInput.Type;

export const GoalAddAgentsMcpInput = Schema.Struct({
  goalId: GoalId,
  count: Schema.Number.check(
    Schema.isInt(),
    Schema.isBetween({ minimum: 1, maximum: MAX_GOAL_AGENT_COUNT }),
  ),
});
export type GoalAddAgentsMcpInput = typeof GoalAddAgentsMcpInput.Type;

export const GoalListMcpInput = Schema.Struct({
  projectId: Schema.optional(ProjectId),
});
export type GoalListMcpInput = typeof GoalListMcpInput.Type;

export const GoalPreviewPlanMcpInput = Schema.Struct({
  projectId: ProjectId,
  queueMode: Schema.Literals(["auto", "standard", "agentqueue"]),
  planPath: Schema.optional(Schema.String),
});
export type GoalPreviewPlanMcpInput = typeof GoalPreviewPlanMcpInput.Type;

/** What a goal's agents run on, without the setup detail. */
export const GoalAgentSummary = Schema.Struct({
  instanceId: Schema.String,
  model: Schema.String,
  count: Schema.Number,
});
export type GoalAgentSummary = typeof GoalAgentSummary.Type;

export const GoalSummary = Schema.Struct({
  id: GoalId,
  name: Schema.String,
  status: GoalStatus,
  projectId: ProjectId,
  detail: Schema.optional(Schema.String),
  queueProgress: Schema.optional(
    Schema.Struct({
      phase: Schema.String,
      total: Schema.Number,
      completed: Schema.Number,
      ready: Schema.Number,
      running: Schema.Number,
      failed: Schema.Number,
      note: Schema.optional(Schema.String),
    }),
  ),
  /** Chats counted by status: running, completed, failed, attention, stopped. */
  chats: Schema.Record(GoalChatStatus, Schema.Number),
  agents: Schema.Array(GoalAgentSummary),
  maxChats: Schema.NullOr(Schema.Number),
  concurrency: Schema.Number,
});
export type GoalSummary = typeof GoalSummary.Type;

export const GoalChatDigest = Schema.Struct({
  threadId: GoalChat.fields.threadId,
  status: GoalChatStatus,
  taskId: Schema.optional(Schema.String),
  taskOutcome: Schema.optional(GoalChat.fields.taskOutcome),
  attentionNote: Schema.optional(Schema.String),
  startedAt: GoalChat.fields.startedAt,
  completedAt: Schema.optional(GoalChat.fields.completedAt),
  overseer: Schema.optional(Schema.Boolean),
});
export type GoalChatDigest = typeof GoalChatDigest.Type;

/** The full goal, with each chat trimmed to what a person or agent needs to follow it. */
export const GoalDetail = Schema.Struct({
  ...Goal.fields,
  chats: Schema.Array(GoalChatDigest),
});
export type GoalDetail = typeof GoalDetail.Type;

export const GoalListMcpResult = Schema.Struct({ goals: Schema.Array(GoalSummary) });
export type GoalListMcpResult = typeof GoalListMcpResult.Type;
