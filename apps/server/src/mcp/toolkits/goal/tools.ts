import {
  GoalAddAgentsMcpInput,
  GoalCreateMcpInput,
  GoalDetail,
  GoalIdMcpInput,
  GoalListMcpInput,
  GoalListMcpResult,
  GoalPreviewPlanMcpInput,
  GoalSummary,
  GoalUpdateMcpInput,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import { GoalPlanPreview } from "@t3tools/contracts/goals";
import * as GoalService from "../../../goals/GoalService.ts";
import { Tool, Toolkit } from "effect/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    GoalService.GoalService,
  ],
};

const GoalListTool = Tool.make("t3_goal_list", {
  ...shared,
  description:
    "List goals in this environment with a compact summary each: status, project, queue progress, chat counts by status, and agents. Pass projectId to list one project's goals.",
  parameters: GoalListMcpInput,
  success: GoalListMcpResult,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GoalReadTool = Tool.make("t3_goal_read", {
  ...shared,
  description:
    "Read one goal in full. Each chat is trimmed to its thread id, status, task, task outcome, attention note, times and whether it is the overseer; open the thread with t3_thread_read for its messages.",
  parameters: GoalIdMcpInput,
  success: GoalDetail,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GoalPreviewPlanTool = Tool.make("t3_goal_preview_plan", {
  ...shared,
  description:
    "Look at a project's repository and plan the way a goal would run, without starting or changing anything. Shows the effective queue mode, whether the goal is blocked, the plan's task counts, and errors and warnings. Call this before t3_goal_create with queueMode 'auto' or 'agentqueue'.",
  parameters: GoalPreviewPlanMcpInput,
  success: GoalPlanPreview,
})
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false);

const GoalCreateTool = Tool.make("t3_goal_create", {
  ...shared,
  description:
    "Create a goal: agents that keep working through a project's plan until nothing is left. Defaults: concurrency 3, maxChats 50, autoResume and standardRules on, queueMode auto. Prefer a draft (start omitted or false) first, then t3_goal_preview_plan, then t3_goal_update or t3_goal_restart to start it. Choose providers, models and effort from orchestrator_capabilities, which reports usage limits: spread agents across providers with headroom, and never pick a model it reports as unavailable. A queue goal (queueMode auto or agentqueue) needs a valid PLAN.md in the repository; if none exists, launch a planning thread with t3_thread_launch whose message asks for the autonomous-plan skill to write one, and create the goal once it is valid. runtimeMode defaults to the caller's access and is clamped to it. Pass clientRequestId to make a retry return the same goal.",
  parameters: GoalCreateMcpInput,
  success: GoalSummary,
}).annotate(Tool.Destructive, true);

const GoalUpdateTool = Tool.make("t3_goal_update", {
  ...shared,
  description:
    "Change a goal's settings. Omitted fields keep their values; the project cannot change. A draft stays a draft; a running goal takes the new settings for chats it starts next, and chats already working keep the instructions they started with. Choose agents from orchestrator_capabilities, and preview a changed plan with t3_goal_preview_plan first.",
  parameters: GoalUpdateMcpInput,
  success: GoalSummary,
}).annotate(Tool.Destructive, true);

const GoalStopTool = Tool.make("t3_goal_stop", {
  ...shared,
  description:
    "Stop a goal from starting new chats. Chats already working are left to finish. Restart it with t3_goal_restart.",
  parameters: GoalIdMcpInput,
  success: GoalSummary,
}).annotate(Tool.Destructive, true);

const GoalRestartTool = Tool.make("t3_goal_restart", {
  ...shared,
  description:
    "Start a draft, or start a stopped, failed or finished goal again. Chats and failures before the restart no longer count toward its limits.",
  parameters: GoalIdMcpInput,
  success: GoalSummary,
}).annotate(Tool.Destructive, true);

const GoalAddAgentsTool = Tool.make("t3_goal_add_agents", {
  ...shared,
  description:
    "Raise a goal's agent count by count (1 to 100) and start the goal if it is not running. Read t3_goal_read first to see its current agents.",
  parameters: GoalAddAgentsMcpInput,
  success: GoalSummary,
}).annotate(Tool.Destructive, true);

export const GoalToolkit = Toolkit.make(
  GoalListTool,
  GoalReadTool,
  GoalPreviewPlanTool,
  GoalCreateTool,
  GoalUpdateTool,
  GoalStopTool,
  GoalRestartTool,
  GoalAddAgentsTool,
);
