import { OrchestratorMcpFailure, ThreadId } from "@t3tools/contracts";
import {
  GoalEscalation,
  GoalEscalationPacket,
  GoalEscalationResolveAction,
  GoalEscalationStatus,
  GoalId,
} from "@t3tools/contracts/goals";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as GoalService from "../../../goals/GoalService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [McpInvocationContext.McpInvocationContext, GoalService.GoalService],
};

const EscalationListTool = Tool.make("t3_escalation_list", {
  ...shared,
  description:
    "List a goal's escalations: problems its workers raised that need an overseer's decision. Filter by goalId and status (open, reviewing, resolved, needs-person, cancelled). Read each one with t3_escalation_read.",
  parameters: Schema.Struct({
    goalId: Schema.optional(GoalId),
    status: Schema.optional(GoalEscalationStatus),
  }),
  success: Schema.Struct({ escalations: Schema.Array(GoalEscalation) }),
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const EscalationReadTool = Tool.make("t3_escalation_read", {
  ...shared,
  description:
    "Read one escalation as a packet: the goal's instructions, the worker chat (task, branch, worktree, attention note), its last replies, the queue briefing for its task, earlier escalations for that worker, and the goal's guidance. Investigate with t3_repo_* and t3_thread_read, then act with t3_escalation_reply or t3_escalation_resolve.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: GoalEscalationPacket,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const EscalationReplyTool = Tool.make("t3_escalation_reply", {
  ...shared,
  description:
    "Send the stuck worker precise instructions in its own conversation and resolve the escalation. Preferred over resolve when the worker can act. Fails if the worker is still working or the escalation is already resolved.",
  parameters: Schema.Struct({
    id: Schema.String,
    message: Schema.String.check(Schema.isMaxLength(8000)),
  }),
  success: GoalEscalation,
}).annotate(Tool.Destructive, false);

const EscalationResolveTool = Tool.make("t3_escalation_resolve", {
  ...shared,
  description:
    "Resolve an escalation without a reply. retry or unblock continues the worker (or re-queues its task, given taskId); give-up hands the worker's work back as a failure; needs-person asks the person to act and says exactly what they must do in note. guidance replaces the note given to workers that start next.",
  parameters: Schema.Struct({
    id: Schema.String,
    action: GoalEscalationResolveAction,
    note: Schema.String.check(Schema.isMaxLength(4000)),
    guidance: Schema.optional(Schema.String.check(Schema.isMaxLength(4000))),
    taskId: Schema.optional(Schema.String),
  }),
  success: Schema.Struct({ id: Schema.String }),
}).annotate(Tool.Destructive, false);

const EscalationOpenTool = Tool.make("t3_escalation_open", {
  ...shared,
  description:
    "Ask the overseer about a worker chat (threadId) or about the whole goal (no threadId). Use it when something needs a decision and no worker is held for it.",
  parameters: Schema.Struct({
    goalId: GoalId,
    threadId: Schema.optional(ThreadId),
    note: Schema.String.check(Schema.isMaxLength(4000)),
  }),
  success: GoalEscalation,
}).annotate(Tool.Destructive, false);

const EscalationCancelTool = Tool.make("t3_escalation_cancel", {
  ...shared,
  description:
    "Cancel an escalation nobody needs to decide. A worker held for it is given up on, as with give-up.",
  parameters: Schema.Struct({ id: Schema.String }),
  success: Schema.Struct({ id: Schema.String }),
}).annotate(Tool.Destructive, true);

export const EscalationToolkit = Toolkit.make(
  EscalationListTool,
  EscalationReadTool,
  EscalationReplyTool,
  EscalationResolveTool,
  EscalationOpenTool,
  EscalationCancelTool,
);
