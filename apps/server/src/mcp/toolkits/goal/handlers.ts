import {
  OrchestratorMcpFailure,
  type GoalChatDigest,
  type GoalDetail,
  type GoalSummary,
} from "@t3tools/contracts";
import {
  GoalSettings,
  type Goal,
  type GoalChat,
  type GoalChatStatus,
  type GoalId,
} from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Struct from "effect/Struct";
import * as GoalService from "../../../goals/GoalService.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { resolveRuntimeMode } from "../../OrchestratorMcpService.ts";
import { readCaller } from "../../threadAccess.ts";
import { GoalToolkit } from "./tools.ts";

const DEFAULT_CONCURRENCY = 3;
const DEFAULT_MAX_CHATS = 50;

/**
 * A repeat `clientRequestId` returns the goal its first call created. Kept in
 * memory only, so a retry after a server restart creates a new goal.
 */
const goalByClientRequest = new Map<string, GoalId>();

const notFound = () =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: "The goal was not found." });

const rejected = (error: { readonly message: string }) =>
  new OrchestratorMcpFailure({ code: "invalid_request", message: error.message });

const present = <K extends string, V>(key: K, value: V | undefined) =>
  value === undefined ? {} : ({ [key]: value } as { [P in K]: V });

/** Drops keys an optional MCP field left unset, so they do not overwrite the defaults. */
const defined = <T extends object>(value: T) =>
  Object.fromEntries(Object.entries(value).filter(([, field]) => field !== undefined)) as {
    [K in keyof T]?: Exclude<T[K], undefined>;
  };

const findGoal = (goals: ReadonlyArray<Goal>, id: GoalId) => {
  const goal = goals.find((candidate) => candidate.id === id);
  return goal === undefined ? Effect.fail(notFound()) : Effect.succeed(goal);
};

const countChats = (chats: ReadonlyArray<GoalChat>) => {
  const counts: Record<GoalChatStatus, number> = {
    running: 0,
    completed: 0,
    failed: 0,
    attention: 0,
    stopped: 0,
  };
  for (const chat of chats) counts[chat.status] += 1;
  return counts;
};

const summarize = (goal: Goal): GoalSummary => {
  const progress = goal.queueProgress;
  return {
    id: goal.id,
    name: goal.name,
    status: goal.status,
    projectId: goal.projectId,
    ...present("detail", goal.detail),
    ...(progress === undefined
      ? {}
      : {
          queueProgress: {
            phase: progress.phase,
            total: progress.total,
            completed: progress.completed,
            ready: progress.ready,
            running: progress.running,
            failed: progress.failed,
            ...present("note", progress.note),
          },
        }),
    chats: countChats(goal.chats),
    agents: goal.agents.map((agent) => ({
      instanceId: agent.modelSelection.instanceId,
      model: agent.modelSelection.model,
      count: agent.count,
    })),
    maxChats: goal.maxChats,
    concurrency: goal.concurrency,
  };
};

const digest = (chat: GoalChat): GoalChatDigest => ({
  threadId: chat.threadId,
  status: chat.status,
  ...present("taskId", chat.taskId),
  ...present("taskOutcome", chat.taskOutcome),
  ...present("attentionNote", chat.attentionNote),
  startedAt: chat.startedAt,
  ...present("completedAt", chat.completedAt),
  ...present("overseer", chat.overseer),
});

const detail = (goal: Goal): GoalDetail => ({ ...goal, chats: goal.chats.map(digest) });

/** The settings a goal was saved with, without its run state. */
const settingsOf = (goal: Goal): GoalSettings =>
  Struct.pick(goal, Object.keys(GoalSettings.fields) as Array<keyof GoalSettings>);

const access = readCaller().pipe(Effect.map((caller) => caller.limits.runtimeMode));

/**
 * A caller can ask for any mode but gets at most its own: an outside client
 * approved for approval-required cannot start a goal that runs full-access.
 */
const clampRuntimeMode = (requested: GoalSettings["runtimeMode"] | undefined) =>
  access.pipe(
    Effect.flatMap((ceiling) =>
      resolveRuntimeMode(ceiling, requested).pipe(Effect.orElseSucceed(() => ceiling)),
    ),
  );

export const layer = McpToolAccess.toLayer(GoalToolkit, {
  t3_goal_list: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      const list = yield* goals.list;
      const rows =
        input.projectId === undefined
          ? list
          : list.filter((goal) => goal.projectId === input.projectId);
      return { goals: rows.map(summarize) };
    }),
  ),
  t3_goal_read: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      return detail(yield* findGoal(yield* goals.list, input.goalId));
    }),
  ),
  t3_goal_preview_plan: McpToolAccess.reads((input) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      return yield* goals.previewPlan(input);
    }),
  ),
  t3_goal_create: McpToolAccess.writes(({ start, clientRequestId, runtimeMode, ...fields }) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      if (clientRequestId !== undefined) {
        const existingId = goalByClientRequest.get(clientRequestId);
        if (existingId !== undefined) {
          const existing = (yield* goals.list).find((goal) => goal.id === existingId);
          if (existing !== undefined) return summarize(existing);
        }
      }
      const settings: GoalSettings = {
        concurrency: DEFAULT_CONCURRENCY,
        maxChats: DEFAULT_MAX_CHATS,
        autoResume: true,
        standardRules: true,
        queueMode: "auto",
        ...defined(fields),
        name: fields.name,
        projectId: fields.projectId,
        agents: fields.agents,
        runtimeMode: yield* clampRuntimeMode(runtimeMode),
      };
      const list = yield* goals
        .create(settings, { draft: start !== true })
        .pipe(Effect.mapError(rejected));
      // The service puts the goal it just created first.
      const created = list[0];
      if (created === undefined)
        return yield* new OrchestratorMcpFailure({
          code: "orchestration_error",
          message: "The goal was not created.",
        });
      if (clientRequestId !== undefined) goalByClientRequest.set(clientRequestId, created.id);
      return summarize(created);
    }),
  ),
  t3_goal_update: McpToolAccess.writes(({ goalId, runtimeMode, ...patch }) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      const current = yield* findGoal(yield* goals.list, goalId);
      const settings: GoalSettings = {
        ...settingsOf(current),
        ...defined(patch),
        ...(runtimeMode === undefined ? {} : { runtimeMode: yield* clampRuntimeMode(runtimeMode) }),
      };
      const list = yield* goals
        .update(goalId, settings, { draft: current.status === "draft" })
        .pipe(Effect.mapError(rejected));
      return summarize(yield* findGoal(list, goalId));
    }),
  ),
  t3_goal_stop: McpToolAccess.writes(({ goalId }) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      yield* findGoal(yield* goals.list, goalId);
      return summarize(yield* findGoal(yield* goals.stop(goalId), goalId));
    }),
  ),
  t3_goal_restart: McpToolAccess.writes(({ goalId }) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      yield* findGoal(yield* goals.list, goalId);
      return summarize(yield* findGoal(yield* goals.restart(goalId), goalId));
    }),
  ),
  t3_goal_add_agents: McpToolAccess.writes(({ goalId, count }) =>
    Effect.gen(function* () {
      const goals = yield* GoalService.GoalService;
      yield* findGoal(yield* goals.list, goalId);
      return summarize(yield* findGoal(yield* goals.addAgents(goalId, count), goalId));
    }),
  ),
});
