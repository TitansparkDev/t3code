// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
import {
  AgentQueueError,
  AgentQueueService,
  type QueueBinding,
} from "../queue/AgentQueueService.ts";
import { findUnmergedLegacyBranches } from "../../../../packages/agent-queue-core/src/index.ts";
/**
 * Runs goals: keeps up to `concurrency` chats working at once, starts the next
 * as each finishes, and stops when an agent says nothing is left.
 *
 * A goal is set up on the new-chat flow's goal page and created over RPC. Every
 * chat is a new ordinary thread in the goal's project: a `thread.create` plus
 * a `thread.turn.start`, the same commands a person's message produces, so
 * provider routing, history and approvals all behave normally.
 *
 * Rules that keep unattended work from running away:
 *  - A chat that fails, or says NEEDS ATTENTION, does not restart its lane, so a
 *    broken setup cannot loop through the chat budget (or forever, when there
 *    is no cap).
 *  - Chats are never archived: they keep a plain "Goal worker #N" title and stay in
 *    the thread list, and the Goals page records how each one ended.
 *  - When a goal gets stuck (agents keep failing, or every chunk is blocked) an
 *    overseer chat is asked once or twice what to do before the goal gives up. It
 *    reads a briefing and answers CONTINUE (with a note for the next workers and
 *    chunks to hand back to the queue) or STOP. It runs on Chat Agents when that
 *    provider is ready, otherwise on one of the goal's own providers.
 *  - A chat stopped by a provider usage limit is not a failure. With auto
 *    resume on, it is scheduled to continue when the limit resets and the goal
 *    waits for it.
 *  - A goal never starts more chats than its cap, per start.
 *  - Chats start at most one every START_SPACING, so providers get breathing room.
 *  - A goal stops starting chats once `stopAfterProblems` finished chats in a
 *    row failed, needed the person, or found only blocked work, so a plan that
 *    cannot be finished does not spend usage all night.
 *  - A provider that is out of usage (reported by the provider registry, or hit
 *    by one of the goal's own chats) gets no new chats until its limit resets, and
 *    a usage limit is never counted against the goal. When every provider the goal
 *    uses is out, the goal waits and carries on by itself.
 *  - A provider whose chats fail is backed off for a while, so a broken account is
 *    not retried every few seconds.
 *  - A chat the person stopped, or one that hit a usage limit before doing any work,
 *    is not a problem: its lane is freed and the goal goes on.
 *  - Stopping a goal never interrupts chats already working; they finish and
 *    are recorded like any other.
 *  - Workers select chunks with plan-work. If a worker finds no eligible chunk,
 *    the goal waits while other workers progress and asks the overseer when idle.
 *
 * @module goals/GoalService
 */
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type OrchestrationThread,
} from "@t3tools/contracts";
import type { ServerProvider } from "@t3tools/contracts";
import {
  type Goal,
  type GoalChat,
  GoalId,
  type GoalProviderPause,
  type GoalSettings,
  GOAL_NUDGE_PROMPT,
  GOAL_OVERSEER_TITLE,
  MAX_GOAL_AGENT_COUNT,
  MAX_GOAL_CONCURRENCY,
  MAX_GOAL_MAX_CHATS,
  goalInstructions,
  goalPrompt,
  queueWorkerPrompt,
  requestedQueueMode,
  type GoalPlanPreview,
  goalSettingsProblem,
  goalWorkerTitle,
  MAX_GOAL_OVERSEER_RUNS,
  parseOverseerReply,
  DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
  problemStreak,
  replyNeedsAttention,
  replyReportsBlockedWork,
  replyReportsGoalComplete,
} from "@t3tools/contracts/goals";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { nextUsageLimitRetryAt, providerUsageLimitFromError } from "../provider/usageLimits.ts";
import { GoalBeads } from "./GoalBeads.ts";
import { GoalStore } from "./GoalStore.ts";

/** Time between one chat starting and the next, per goal. Zero in tests. */
export const StartSpacingMillis = Context.Reference<number>("t3/goals/StartSpacingMillis", {
  defaultValue: () => 15_000,
});

/** How often running goals look for room to start another chat. */
const TICK_INTERVAL = "5 seconds";

export class GoalService extends Context.Service<
  GoalService,
  {
    /** Create a goal and start its first chats. */
    readonly create: (
      settings: GoalSettings,
      options?: { readonly draft?: boolean },
    ) => Effect.Effect<ReadonlyArray<Goal>, OrchestrationDispatchCommandError>;
    readonly list: Effect.Effect<ReadonlyArray<Goal>>;
    /** Change any setting. Chats already working keep the instructions they started with. */
    readonly update: (
      id: GoalId,
      settings: GoalSettings,
      options?: { readonly draft?: boolean },
    ) => Effect.Effect<ReadonlyArray<Goal>, OrchestrationDispatchCommandError>;
    /** Stop starting chats. Chats already working are left to finish. */
    readonly stop: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    /** Start a draft, or start a stopped, stopped-early or finished goal again. */
    readonly restart: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    /** What a goal would run on for this project and plan, without starting anything. */
    readonly previewPlan: (input: {
      readonly projectId: Goal["projectId"];
      readonly queueMode: "auto" | "standard" | "agentqueue";
      readonly planPath?: string | undefined;
    }) => Effect.Effect<GoalPlanPreview>;
    /** Raise the agent counts by `count` and start the goal if it is not running. */
    readonly addAgents: (id: GoalId, count: number) => Effect.Effect<ReadonlyArray<Goal>>;
    readonly remove: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    /** Recovers goals after a restart, then reacts to chats finishing. Fork it. */
    readonly loop: Effect.Effect<void>;
  }
>()("t3/goals/GoalService") {}

/**
 * Chats that count against this start: a restart gets a fresh budget. A chat
 * still working always counts, whenever it began.
 */
export function chatsSinceStart(goal: Goal): ReadonlyArray<GoalChat> {
  const since = Date.parse(goal.restartedAt ?? goal.createdAt);
  // A finished overseer is not a worker: it never counts toward the budget or the problem streak.
  const reviewed = goal.reviewedChats ?? 0;
  return goal.chats.filter(
    (chat, position) =>
      chat.status === "running" ||
      (!chat.overseer && position >= reviewed && Date.parse(chat.startedAt) >= since),
  );
}

/**
 * Which agent the next chat should use, or undefined when none has room. The
 * agent furthest below its own count goes first, so counts fill evenly. Agents
 * in `unavailable` (by index) are skipped, and chats waiting for a usage limit
 * to reset do not hold a lane: they continue by themselves later.
 */
export function nextAgentIndex(
  goal: Goal,
  unavailable: ReadonlySet<number> = new Set(),
): number | undefined {
  if (goal.status !== "running" || goal.holdStarts) return undefined;
  const chats = chatsSinceStart(goal);
  const running = chats.filter(
    (chat) => chat.status === "running" && !chat.waitingForLimit && !chat.overseer,
  );
  // A queue goal re-queues the task of a failed chat, so a failed chat does not hold a lane.
  const blocked =
    goal.agentQueue !== undefined
      ? 0
      : chats.filter((chat) => chat.status === "failed" || chat.status === "attention").length;
  // A failed chat, or one waiting for the person, keeps its lane closed for the rest of this start.
  if (running.length + blocked >= goal.concurrency) return undefined;
  if (goal.maxChats !== null && chats.length >= goal.maxChats) return undefined;
  let best: { index: number; load: number } | undefined;
  goal.agents.forEach((agent, index) => {
    if (unavailable.has(index)) return;
    const active = running.filter((chat) => chat.agentIndex === index).length;
    if (active >= agent.count) return;
    const load = active / agent.count;
    if (!best || load < best.load) best = { index, load };
  });
  return best?.index;
}

/** Words in a usage window's name that say nothing about which models it covers. */
const GENERIC_WINDOW_WORDS = new Set([
  "weekly",
  "daily",
  "monthly",
  "session",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "month",
  "limit",
  "limits",
  "usage",
  "quota",
  "five",
  "seven",
  "thirty",
  "primary",
  "secondary",
  "window",
  "rolling",
  "spend",
  "credits",
]);

/**
 * Whether a usage window covers `model`. A window named for a model family
 * (Claude's `seven_day_opus`, Antigravity's "Gemini 3 Flash") covers only models
 * that carry all of those words; a plain session or weekly window covers every model.
 */
export function windowCoversModel(
  window: { readonly id: string; readonly label: string },
  model: string,
): boolean {
  const words = `${window.id} ${window.label}`
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/u.test(word) && !GENERIC_WINDOW_WORDS.has(word));
  const slug = model.toLowerCase();
  return words.every((word) => slug.includes(word));
}

/** A usage window counts as used up from this percentage. */
const WINDOW_FULL_PERCENT = 99.5;

/**
 * Why a provider cannot take new chats for `model` right now, or undefined. Looks
 * at the provider's own report: not installed, switched off, signed out, or a
 * usage window used up that has not reset yet.
 */
export function providerBlock(
  provider: ServerProvider | undefined,
  model: string,
  nowMs: number,
): { readonly until?: number; readonly reason: string } | undefined {
  if (!provider) return { reason: "is not set up" };
  if (!provider.enabled) return { reason: "is switched off" };
  if (provider.availability === "unavailable" || !provider.installed) {
    return { reason: "is not installed" };
  }
  if (provider.auth.status === "unauthenticated") return { reason: "is signed out" };
  let until: number | undefined;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < WINDOW_FULL_PERCENT || window.resetsAt === undefined) continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (!(resetsAt > nowMs) || !windowCoversModel(window, model)) continue;
    until = Math.max(until ?? 0, resetsAt);
  }
  return until === undefined ? undefined : { until, reason: "is out of usage" };
}

/** Minutes a provider is left alone after failures in a row, growing to an hour. */
const ERROR_BACKOFF_MINUTES = [5, 15, 30, 60] as const;

/** Whether a pause applies to this agent. Antigravity limits are per model; others cover the account. */
const pauseCovers = (pause: GoalProviderPause, instanceId: string, model: string) =>
  pause.instanceId === instanceId && (pause.model === undefined || pause.model === model);

const lastAssistantReply = (thread: OrchestrationThread | undefined) =>
  thread?.messages.findLast((message) => message.role === "assistant")?.text;

/** A chat that has said or done nothing yet loses nothing if it is dropped. */
const madeProgress = (thread: OrchestrationThread | undefined) =>
  thread !== undefined &&
  (thread.messages.some((message) => message.role === "assistant") || thread.activities.length > 0);

interface UsageLimitHit {
  readonly retryAt?: string | undefined;
}

/** The usage limit a thread's session stopped on, however the provider worded it. */
function usageLimitOf(thread: OrchestrationThread | undefined): UsageLimitHit | undefined {
  const session = thread?.session;
  if (!session) return undefined;
  if (session.lastErrorClass === "usage_limit") return { retryAt: session.retryAt };
  if (session.lastError === null) return undefined;
  const limit = providerUsageLimitFromError({
    message: session.lastError,
    ...(session.retryAt !== undefined ? { retryAt: session.retryAt } : {}),
  });
  return limit === null ? undefined : { retryAt: limit.retryAt };
}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const store = yield* GoalStore;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /** Chats still working, and whether their turn has been seen running yet. */
  const watching = new Map<ThreadId, { goalId: GoalId; seenRunning: boolean }>();
  /** Serializes everything that changes a goal's chats, so lanes are never over-filled. */
  const lock = yield* Semaphore.make(1);
  const queue = yield* AgentQueueService;
  /** Background work (submissions, merges) lives as long as the service, and ends with it. */
  const background = yield* Effect.scope;
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.forkIn(effect, background);
  const repositoryContext = yield* GoalBeads;
  const registry = yield* ProviderRegistry;
  const spacing = yield* StartSpacingMillis;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  /** When each goal last started a chat, for spacing starts apart. */
  const lastStart = new Map<GoalId, number>();
  /** Why each goal was stuck when its overseer was asked, for the failure message. */
  const stuckReasons = new Map<GoalId, string>();

  const logFailure = (message: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logWarning(message, { cause: Cause.pretty(cause) });

  const readThread = (threadId: ThreadId) =>
    snapshots.getThreadDetailById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  const addChat = (goalId: GoalId, chat: GoalChat) =>
    store.update(goalId, (current) => ({
      ...current,
      chats: [...current.chats, chat],
      updatedAt: chat.startedAt,
      // A running goal's detail only ever says it is waiting; it is not waiting now.
      waitingUntil: undefined,
      detail: current.status === "running" ? undefined : current.detail,
    }));

  const updateChat = (goalId: GoalId, threadId: ThreadId, change: Partial<GoalChat>) =>
    Effect.gen(function* () {
      const updatedAt = yield* nowIso;
      return yield* store.update(goalId, (goal) => ({
        ...goal,
        updatedAt,
        chats: goal.chats.map((chat) =>
          chat.threadId === threadId ? { ...chat, ...change } : chat,
        ),
      }));
    });

  const setStatus = (goalId: GoalId, status: Goal["status"], detail?: string) =>
    Effect.gen(function* () {
      const now = yield* nowIso;
      return yield* store.update(goalId, (goal) => ({
        ...goal,
        status,
        updatedAt: now,
        ...(status === "running"
          ? { restartedAt: now, completedAt: undefined, detail: undefined }
          : { completedAt: now, detail: detail ?? undefined }),
      }));
    });

  const currentGoal = (goalId: GoalId) =>
    Effect.map(store.list, (goals) => goals.find((candidate) => candidate.id === goalId));

  const workspaceRootOf = (projectId: Goal["projectId"]) =>
    snapshots.getProjectShells([projectId]).pipe(
      Effect.map((projects) => projects[0]?.workspaceRoot),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );

  /**
   * The goal's agents (by index) that cannot take a new chat right now, with when
   * they come back (undefined when that is not known) and what is wrong.
   */
  const unavailableAgents = Effect.fn("GoalService.unavailableAgents")(function* (goal: Goal) {
    const now = yield* nowMillis;
    const providers = yield* registry.getProviders.pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ServerProvider>)),
    );
    const unavailable = new Map<number, { until?: number; reason: string; name: string }>();
    goal.agents.forEach((agent, index) => {
      const { instanceId, model } = agent.modelSelection;
      const provider = providers.find((candidate) => candidate.instanceId === instanceId);
      const name = provider?.displayName ?? String(instanceId);
      const paused = (goal.pauses ?? []).find(
        (pause) => Date.parse(pause.until) > now && pauseCovers(pause, instanceId, model),
      );
      const block = providerBlock(provider, model, now);
      const until = Math.max(paused ? Date.parse(paused.until) : 0, block?.until ?? 0);
      if (!paused && !block) return;
      unavailable.set(index, {
        ...(until > 0 && (block === undefined || block.until !== undefined || paused)
          ? { until }
          : {}),
        reason: paused
          ? paused.reason === "usage-limit"
            ? "hit its usage limit"
            : "keeps failing"
          : (block?.reason ?? ""),
        name,
      });
    });
    return unavailable;
  });

  /** Set one provider aside for a while after a usage limit, or after chats on it failed. */
  const pauseAgent = Effect.fn("GoalService.pauseAgent")(function* (
    goalId: GoalId,
    agent: Goal["agents"][number],
    reason: GoalProviderPause["reason"],
    retryAt?: string,
  ) {
    const now = yield* nowMillis;
    const nowText = yield* nowIso;
    const { instanceId, model } = agent.modelSelection;
    const providers = yield* registry.getProviders.pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ServerProvider>)),
    );
    // Antigravity limits belong to a model group; every other provider's cover the account.
    const perModel =
      reason === "usage-limit" &&
      providers.find((provider) => provider.instanceId === instanceId)?.driver === "antigravity";
    yield* store.update(goalId, (goal) => {
      const existing = (goal.pauses ?? []).find((pause) =>
        pauseCovers(pause, instanceId, perModel ? model : ""),
      );
      const stillPaused = existing !== undefined && Date.parse(existing.until) > now;
      const strikes = (existing?.strikes ?? 0) + (stillPaused ? 0 : 1);
      const until =
        reason === "usage-limit"
          ? nextUsageLimitRetryAt({
              now: nowText as never,
              attempt: Math.max(strikes - 1, 0),
              ...(retryAt !== undefined ? { providerRetryAt: retryAt as never } : {}),
            })
          : (DateTime.formatIso(
              DateTime.makeUnsafe(now + ERROR_BACKOFF_MINUTES[Math.min(strikes - 1, 3)]! * 60_000),
            ) as never);
      const kept = (goal.pauses ?? []).filter(
        (pause) =>
          !(pause.instanceId === instanceId && pause.model === (perModel ? model : undefined)),
      );
      const pause: GoalProviderPause = {
        instanceId,
        ...(perModel ? { model } : {}),
        until:
          stillPaused && Date.parse(existing.until) > Date.parse(until) ? existing.until : until,
        reason: stillPaused && existing.reason === "usage-limit" ? "usage-limit" : reason,
        strikes,
      };
      return { ...goal, pauses: [...kept, pause] };
    });
  });

  /** A chat on this agent finished its work: forget earlier failures of that provider. */
  const clearPauses = (goalId: GoalId, agent: Goal["agents"][number]) =>
    store.update(goalId, (goal) => {
      const { instanceId, model } = agent.modelSelection;
      const pauses = (goal.pauses ?? []).filter((pause) => !pauseCovers(pause, instanceId, model));
      return pauses.length === (goal.pauses ?? []).length
        ? goal
        : { ...goal, pauses: pauses.length > 0 ? pauses : undefined };
    });

  /** Say, on the goal, that it is running but waiting for a provider to come back. */
  const markWaiting = (
    goalId: GoalId,
    unavailable: ReadonlyMap<number, { until?: number; reason: string; name: string }>,
  ) =>
    store.update(goalId, (goal) => {
      const entries = [...unavailable.values()];
      const times = entries.map((entry) => entry.until);
      const known = times.every((time) => time !== undefined);
      const waitingUntil = known
        ? (DateTime.formatIso(DateTime.makeUnsafe(Math.min(...(times as number[])))) as never)
        : undefined;
      const names = [...new Set(entries.map((entry) => `${entry.name} ${entry.reason}`))].join(
        "; ",
      );
      const detail = `Waiting: ${names}. The goal carries on by itself when one is back.`;
      return goal.waitingUntil === waitingUntil && goal.detail === detail
        ? goal
        : { ...goal, waitingUntil, detail: detail as never };
    });

  /** The goal is no longer waiting on a provider. */
  const clearWaiting = (goalId: GoalId) =>
    store.update(goalId, (goal) =>
      goal.waitingUntil === undefined && goal.detail === undefined
        ? goal
        : { ...goal, waitingUntil: undefined, detail: undefined },
    );

  /**
   * Open one new chat for the goal and send its first message. Returns whether it
   * started. A worker's provider is backed off when it cannot start; an overseer's is not.
   */
  const openChat = Effect.fn("GoalService.openChat")(function* (
    goal: Goal,
    chat: {
      readonly title: string;
      readonly text: string;
      readonly agentIndex: number;
      readonly modelSelection: Goal["agents"][number]["modelSelection"];
      readonly overseer?: boolean | undefined;
      readonly worktreePath?: string | null | undefined;
      readonly branch?: string | null | undefined;
      readonly taskId?: string | undefined;
      readonly claimToken?: string | undefined;
      readonly baseBranch?: string | undefined;
    },
  ) {
    const agent = goal.agents[chat.agentIndex];
    const threadId = ThreadId.make(yield* randomUUID);
    const createdAt = yield* nowIso;
    const modelSelection = chat.modelSelection;
    const backOff = agent && !chat.overseer ? pauseAgent(goal.id, agent, "errors") : Effect.void;
    const created = yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`goal-create:${yield* randomUUID}`),
        threadId,
        projectId: goal.projectId,
        title: chat.title,
        modelSelection,
        runtimeMode: goal.runtimeMode,
        interactionMode: "default",
        branch: chat.branch ?? null,
        worktreePath: chat.worktreePath ?? null,
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logFailure("goals.chat-create-failed")(cause).pipe(Effect.as(false)),
        ),
      );
    if (!created) {
      // Back off, so a broken project or provider is not retried on every tick.
      yield* backOff;
      return null;
    }
    // Registered before the turn starts so a fast provider cannot finish unseen.
    watching.set(threadId, { goalId: goal.id, seenRunning: false });
    yield* addChat(goal.id, {
      threadId,
      agentIndex: chat.agentIndex,
      status: "running",
      startedAt: createdAt,
      ...(chat.overseer ? { overseer: true } : {}),
      ...(chat.taskId ? { taskId: chat.taskId } : {}),
      ...(chat.worktreePath ? { worktreePath: chat.worktreePath } : {}),
      ...(chat.branch ? { branch: chat.branch } : {}),
      ...(chat.claimToken ? { claimToken: chat.claimToken } : {}),
      ...(chat.baseBranch ? { baseBranch: chat.baseBranch } : {}),
    });
    // No title seed: the plain title is kept instead of being replaced by a generated one.
    const started = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`goal-turn:${yield* randomUUID}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text: chat.text,
          attachments: [],
        },
        modelSelection,
        runtimeMode: goal.runtimeMode,
        interactionMode: "default",
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logFailure("goals.chat-start-failed")(cause).pipe(Effect.as(false)),
        ),
      );
    if (!started) {
      watching.delete(threadId);
      yield* backOff;
      yield* updateChat(goal.id, threadId, { status: "failed", completedAt: yield* nowIso });
      yield* engine
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`goal-cleanup:${yield* randomUUID}`),
          threadId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return started ? threadId : null;
  });

  /** Open a standard (plan-work) worker chat for the goal on `agentIndex`, titled "Goal worker #N". */
  const startStandardChat = Effect.fn("GoalService.startStandardChat")(function* (
    goal: Goal,
    agentIndex: number,
  ) {
    const agent = goal.agents[agentIndex];
    if (!agent) return "none" as const;
    const threadId = yield* openChat(goal, {
      title: goalWorkerTitle(goal.chats.filter((chat) => !chat.overseer).length + 1),
      text: goalPrompt(goal),
      agentIndex,
      modelSelection: agent.modelSelection,
    });
    return threadId !== null ? ("started" as const) : ("failed" as const);
  });

  /** An AgentQueue failure is recorded on the goal; the third in a row stops it with the reason. */
  const queueFailed = (goalId: GoalId, operation: string, error: AgentQueueError) =>
    Effect.gen(function* () {
      yield* Effect.logWarning("goals.agentqueue-failed", {
        goalId,
        operation,
        message: error.message,
      });
      const updated = yield* store.update(goalId, (goal) => ({
        ...goal,
        queueErrors: (goal.queueErrors ?? 0) + 1,
        detail: `AgentQueue ${operation} failed: ${error.message}`.slice(0, 500) as never,
      }));
      if ((updated?.queueErrors ?? 0) >= 3) {
        yield* setStatus(
          goalId,
          "failed",
          `AgentQueue ${operation} failed ${updated?.queueErrors} times in a row: ${error.message}`.slice(
            0,
            1500,
          ),
        );
      }
    });

  const queueHealthy = (goalId: GoalId) =>
    store.update(goalId, (goal) =>
      goal.queueErrors === undefined ? goal : { ...goal, queueErrors: undefined },
    );

  const logQueueError = (message: string) => (error: AgentQueueError) =>
    Effect.logWarning(message, { operation: error.operation, error: error.message });

  /** Undo a reservation whose chat never started: the task goes back untouched. */
  const returnReservation = (
    binding: QueueBinding,
    claimToken: string,
    worktreePath: string,
    branch: string,
    reason: string,
  ) =>
    Effect.gen(function* () {
      yield* queue
        .release(binding, claimToken, "pending", reason)
        .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
      yield* queue
        .teardown(binding, worktreePath, branch, false)
        .pipe(Effect.catch(logQueueError("goals.agentqueue-teardown-failed")));
    });

  /**
   * Reserve a ready task, then open a chat for it. The reservation comes first: when no
   * task is ready this returns "none" without creating a thread or spending a model turn.
   */
  const startQueueChat = Effect.fn("GoalService.startQueueChat")(function* (
    goal: Goal,
    binding: QueueBinding,
    agentIndex: number,
  ) {
    const agent = goal.agents[agentIndex];
    if (!agent) return "none" as const;
    const workerId = `goal-${goal.id}-agent-${agentIndex}-${yield* randomUUID}`;
    const reserved = yield* queue.reserveNext(binding, workerId).pipe(
      Effect.map((task) => ({ ok: true as const, task })),
      Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
    );
    if (!reserved.ok) {
      yield* queueFailed(goal.id, "reserve", reserved.error);
      return "failed" as const;
    }
    yield* queueHealthy(goal.id);
    const task = reserved.task;
    if (!task) return "none" as const;

    const threadId = yield* openChat(goal, {
      title: `${task.repair ? "Repair" : "Goal worker"}: ${task.taskId} ${task.title}`.slice(
        0,
        120,
      ),
      text: queueWorkerPrompt(goal, {
        taskId: task.taskId,
        title: task.title,
        description: task.description,
        verificationCommand: task.verificationCommand,
        worktreePath: task.worktreePath,
        branch: task.branch,
        baseBranch: task.baseBranch,
        planPath: binding.planPath,
        retryCount: task.retryCount,
        lastFailure: task.lastFailure,
        repair: task.repair?.reason ?? null,
      }),
      agentIndex,
      modelSelection: agent.modelSelection,
      worktreePath: task.worktreePath,
      branch: task.branch,
      taskId: task.taskId,
      claimToken: task.claimToken,
      baseBranch: task.baseBranch,
    });
    if (threadId === null) {
      yield* returnReservation(
        binding,
        task.claimToken,
        task.worktreePath,
        task.branch,
        "Goal worker did not start",
      );
      return "failed" as const;
    }
    return "started" as const;
  });

  const startChat = Effect.fn("GoalService.startChat")(function* (goal: Goal, agentIndex: number) {
    return goal.agentQueue
      ? yield* startQueueChat(goal, goal.agentQueue, agentIndex)
      : yield* startStandardChat(goal, agentIndex);
  });

  // ───────────────────────── AgentQueue lifecycle ─────────────────────────
  //
  // Four things are kept apart on purpose:
  //  - a task's implementation finishing: the worker's work is recorded as a *candidate*;
  //  - the task being completed: only the queue says so, after the candidate is merged;
  //  - a worker settling: its thread is settled and its lane freed once its turn ended;
  //  - the goal completing: only `verifyPlanCompletion` can say so.
  // Nothing a worker writes decides any of them.

  /** What a thread's failure says about its provider when it did no work: a login, a keyring, a crash. */
  const providerFailureOf = (thread: OrchestrationThread | undefined): string | undefined => {
    if (madeProgress(thread)) return undefined;
    const error = thread?.session?.lastError ?? undefined;
    if (error) return error;
    return thread?.latestTurn?.state === "completed"
      ? undefined
      : "The provider stopped before doing any work.";
  };

  /** Settle a worker's thread with the orchestration engine's own settle command (idempotent id). */
  const settleThread = (threadId: ThreadId) =>
    engine
      .dispatch({
        type: "thread.settle",
        commandId: CommandId.make(`goal-settle:${threadId}`),
        threadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));

  /** Goals with an integration pass running, so one goal never integrates twice at once. */
  const integrating = new Set<GoalId>();
  /** Submissions being verified, keyed by claim token. */
  const submitting = new Set<string>();

  /** Where an AgentQueue goal stands, from the queue's own records. */
  const refreshProgress = Effect.fn("GoalService.refreshProgress")(function* (goal: Goal) {
    const binding = goal.agentQueue;
    if (!binding) return;
    const status = yield* queue.status(binding).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        logQueueError("goals.agentqueue-status-failed")(error).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(status)) return;
    const { snapshot, candidates, ready } = status.value;
    const awaiting = candidates.filter((c) => c.state === "pending" || c.state === "conflict");
    const needsRepair = candidates.filter((c) => c.state === "repair_needed").length;
    const running = snapshot.counts.claimed + snapshot.counts.running;
    const waiting = Math.max(snapshot.counts.pending - ready, 0);
    const deferred = awaiting.find((c) => c.state === "pending" && c.error)?.error ?? undefined;
    const phase: NonNullable<Goal["queueProgress"]>["phase"] =
      goal.status === "complete"
        ? "complete"
        : running > 0 && !(ready === 0 && waiting > 0 && awaiting.length === 0)
          ? "implementing"
          : running > 0
            ? "waiting-dependencies"
            : awaiting.length > 0
              ? "waiting-integration"
              : needsRepair > 0 || snapshot.counts.failed > 0 || snapshot.counts.blocked > 0
                ? "blocked"
                : ready > 0
                  ? "idle"
                  : waiting > 0
                    ? "blocked"
                    : "idle";
    const next = {
      total: snapshot.counts.total,
      completed: snapshot.counts.completed,
      ready,
      waiting,
      running,
      awaitingIntegration: awaiting.length,
      needsRepair,
      failed: snapshot.counts.failed + snapshot.counts.blocked,
      phase,
      ...(deferred ? { note: deferred.slice(0, 300) } : {}),
    };
    const previous = goal.queueProgress;
    if (
      previous &&
      JSON.stringify({ ...previous, checkedAt: "" }) === JSON.stringify({ ...next, checkedAt: "" })
    ) {
      return;
    }
    const checkedAt = yield* nowIso;
    yield* store.update(goal.id, (current) => ({
      ...current,
      queueProgress: { ...next, checkedAt },
    }));
  });

  /** Merge every submitted candidate of a goal. Runs beside the scheduler and never blocks it. */
  const runIntegration: (goalId: GoalId) => Effect.Effect<void> = Effect.fn(
    "GoalService.runIntegration",
  )(function* (goalId: GoalId) {
    while (true) {
      const goal = yield* currentGoal(goalId);
      const binding = goal?.agentQueue;
      if (!goal || !binding) return;
      const candidates = yield* queue
        .candidates(binding)
        .pipe(
          Effect.catch((error) => queueFailed(goalId, "candidates", error).pipe(Effect.as([]))),
        );
      const pending = candidates.filter((candidate) => candidate.state === "pending");
      if (pending.length === 0) return;
      let progressed = false;
      for (const candidate of pending) {
        const outcome = yield* queue.integrate(binding, candidate.taskId).pipe(
          Effect.map(Option.some),
          Effect.catch((error) =>
            queueFailed(goalId, "integrate", error).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isNone(outcome)) return;
        yield* queueHealthy(goalId);
        const result = outcome.value;
        if (result.kind === "landed") {
          progressed = true;
          if (candidate.candidateWorktree && candidate.candidateBranch) {
            yield* queue
              .teardown(binding, candidate.candidateWorktree, candidate.candidateBranch, true)
              .pipe(Effect.catch(logQueueError("goals.agentqueue-worktree-cleanup-failed")));
          }
          yield* store.update(goalId, (current) => ({
            ...current,
            chats: current.chats.map((chat) =>
              chat.taskId === candidate.taskId && chat.taskOutcome === "submitted"
                ? { ...chat, taskOutcome: "integrated" as const }
                : chat,
            ),
          }));
        } else if (result.kind === "needs-repair") {
          progressed = true;
          yield* Effect.logWarning("goals.agentqueue-merge-needs-repair", {
            goalId,
            taskId: candidate.taskId,
            exhausted: result.exhausted,
            reason: result.reason,
          });
        } else if (result.kind === "deferred") {
          yield* Effect.logInfo("goals.agentqueue-merge-deferred", {
            goalId,
            taskId: candidate.taskId,
            reason: result.reason,
          });
        }
      }
      // Landed work unlocks dependants and a conflict needs a repair worker: schedule now.
      if (!progressed) return;
      yield* fillLanes(goalId).pipe(
        lock.withPermits(1),
        Effect.catchCause(logFailure("goals.integration-fill-failed")),
      );
    }
  });

  const ensureIntegration = (goalId: GoalId): Effect.Effect<void> =>
    integrating.has(goalId)
      ? Effect.void
      : Effect.gen(function* () {
          integrating.add(goalId);
          yield* fork(
            runIntegration(goalId).pipe(
              Effect.catchCause(logFailure("goals.integration-failed")),
              Effect.ensuring(Effect.sync(() => integrating.delete(goalId))),
            ),
          );
        });

  /** Give a worker's claim back and keep whatever it wrote; the next worker resumes from it. */
  const handBack = Effect.fn("GoalService.handBack")(function* (
    binding: QueueBinding,
    chat: GoalChat,
    how: "pending" | "retry" | "blocked",
    reason: string,
  ) {
    if (!chat.claimToken) return;
    yield* queue
      .release(binding, chat.claimToken, how, reason)
      .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
    if (chat.worktreePath && chat.branch) {
      yield* queue
        .teardown(binding, chat.worktreePath, chat.branch, false)
        .pipe(Effect.catch(logQueueError("goals.agentqueue-teardown-failed")));
    }
  });

  const NO_COMMIT_PROMPT =
    "The server found no commit on your branch beyond the base branch. Implement the assigned task in your worktree and commit it there (git add, git commit). Do not skip the commit; uncommitted work is not submitted.";

  /**
   * A queue worker's submission, run beside the scheduler: commit leftovers, run the
   * task's check, record the candidate. Success settles the worker and starts the merge;
   * a failed check sends the worker back to fix it, up to twice.
   */
  const submitFlow = Effect.fn("GoalService.submitFlow")(function* (
    goalId: GoalId,
    threadId: ThreadId,
  ) {
    const goal = yield* currentGoal(goalId);
    const binding = goal?.agentQueue;
    const chat = goal?.chats.find((candidate) => candidate.threadId === threadId);
    if (
      !goal ||
      !binding ||
      !chat?.claimToken ||
      !chat.taskId ||
      !chat.worktreePath ||
      !chat.branch
    ) {
      return;
    }
    if (submitting.has(chat.claimToken)) return;
    submitting.add(chat.claimToken);
    const token = chat.claimToken;
    yield* Effect.gen(function* () {
      const info = yield* queue
        .taskInfo(binding, chat.taskId!)
        .pipe(Effect.catch(() => Effect.succeed(null)));
      const outcome = yield* queue
        .submit(binding, {
          taskId: chat.taskId!,
          claimToken: token,
          worktreePath: chat.worktreePath!,
          branch: chat.branch!,
          verificationCommand: info?.verificationCommand ?? "",
        })
        .pipe(
          Effect.map((value) => ({ ok: true as const, value })),
          Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
        );
      yield* Effect.gen(function* () {
        const fresh = yield* currentGoal(goalId);
        const current = fresh?.chats.find((candidate) => candidate.threadId === threadId);
        if (!fresh || !current) return;
        const now = yield* nowIso;
        if (!outcome.ok) {
          yield* queueFailed(goalId, "submit", outcome.error);
          yield* handBack(binding, current, "retry", `Submission failed: ${outcome.error.message}`);
          yield* updateChat(goalId, threadId, {
            status: "failed",
            completedAt: now,
            taskOutcome: "retry",
          });
          return yield* fillLanes(goalId);
        }
        yield* queueHealthy(goalId);
        const result = outcome.value;
        switch (result.kind) {
          case "submitted": {
            yield* updateChat(goalId, threadId, { taskOutcome: "submitted", completedAt: now });
            yield* settleThread(threadId);
            yield* ensureIntegration(goalId);
            return yield* fillLanes(goalId);
          }
          case "claim-lost": {
            yield* updateChat(goalId, threadId, {
              status: "stopped",
              completedAt: now,
              taskOutcome: "returned",
            });
            return yield* fillLanes(goalId);
          }
          case "no-changes":
          case "verification-failed": {
            const tries = current.landingRetries ?? 0;
            const feedback =
              result.kind === "no-changes"
                ? NO_COMMIT_PROMPT
                : `The server ran the task's check on your commit and it failed:\n${result.error}\nFix it in your worktree, run the check yourself, and commit.`;
            if (tries < (result.kind === "no-changes" ? 1 : 2) && fresh.status === "running") {
              yield* updateChat(goalId, threadId, { landingRetries: tries + 1 });
              if (yield* continueChat(fresh, current, feedback)) return;
            }
            yield* handBack(
              binding,
              current,
              "retry",
              result.kind === "no-changes" ? "The worker made no commit." : result.error,
            );
            yield* updateChat(goalId, threadId, {
              status: "failed",
              completedAt: now,
              taskOutcome: "retry",
            });
            return yield* settleAfterProblem(goalId);
          }
        }
      }).pipe(lock.withPermits(1));
    }).pipe(Effect.ensuring(Effect.sync(() => submitting.delete(token))));
  });

  /** Too many chats in a row that could not finish their task: stop and say so. */
  const settleAfterProblem = Effect.fn("GoalService.settleAfterProblem")(function* (
    goalId: GoalId,
  ) {
    const after = yield* currentGoal(goalId);
    if (!after || after.status !== "running") return;
    const limit = after.stopAfterProblems ?? DEFAULT_GOAL_STOP_AFTER_PROBLEMS;
    if (problemStreak(chatsSinceStart(after)) >= limit) {
      yield* escalate(
        goalId,
        `The last ${limit} workers in a row could not get their task verified and merged.`,
      );
      return;
    }
    yield* fillLanes(goalId);
  });

  /**
   * A queue worker's turn is over. The queue's records decide what became of its task;
   * the worker's final message is only read for a request for a person.
   */
  const finishQueueChat = Effect.fn("GoalService.finishQueueChat")(function* (
    goal: Goal,
    binding: QueueBinding,
    chat: GoalChat,
    thread: OrchestrationThread | undefined,
    knownLimit: UsageLimitHit | undefined,
  ) {
    const goalId = goal.id;
    const threadId = chat.threadId;
    const now = yield* nowIso;
    const token = chat.claimToken!;

    // 1. Evidence first: what does the queue say about this task right now?
    const info = chat.taskId
      ? yield* queue.taskInfo(binding, chat.taskId).pipe(Effect.catch(() => Effect.succeed(null)))
      : null;
    const claims = yield* queue
      .activeClaims(binding)
      .pipe(Effect.catch(() => Effect.succeed([] as const)));
    const holdsClaim = claims.some((claim) => claim.claimToken === token);
    if (info?.status === "completed") {
      yield* updateChat(goalId, threadId, {
        status: "completed",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "integrated",
      });
      yield* settleThread(threadId);
      yield* store.update(goalId, (current) => ({ ...current, holdStarts: undefined }));
      return yield* fillLanes(goalId);
    }
    if (!holdsClaim) {
      const candidates = yield* queue
        .candidates(binding)
        .pipe(Effect.catch(() => Effect.succeed([] as const)));
      const candidate = candidates.find((entry) => entry.taskId === chat.taskId);
      if (candidate && candidate.state !== "repairing") {
        yield* updateChat(goalId, threadId, {
          status: "completed",
          completedAt: now,
          waitingForLimit: undefined,
          taskOutcome: "submitted",
        });
        yield* settleThread(threadId);
        yield* ensureIntegration(goalId);
        return yield* fillLanes(goalId);
      }
      // The claim is gone (lease recovery took it): the work was preserved, nothing to do here.
      yield* updateChat(goalId, threadId, {
        status: "stopped",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "returned",
      });
      return yield* fillLanes(goalId);
    }

    // 2. The claim is still ours: classify how the turn ended.
    const interrupted = thread?.latestTurn?.state === "interrupted";
    const failedTurn = knownLimit !== undefined || thread?.latestTurn?.state !== "completed";
    const hit = knownLimit ?? (failedTurn && !interrupted ? usageLimitOf(thread) : undefined);
    const stopped = hit !== undefined || interrupted;
    const providerFailure = failedTurn && !stopped ? providerFailureOf(thread) : undefined;
    const agent = goal.agents[chat.agentIndex];
    if (agent) {
      if (hit) yield* pauseAgent(goalId, agent, "usage-limit", hit.retryAt);
      else if (providerFailure) yield* pauseAgent(goalId, agent, "errors");
    }

    if (stopped || providerFailure !== undefined) {
      // Not the task's fault: it goes back without spending a retry, with its work kept.
      yield* handBack(
        binding,
        chat,
        "pending",
        hit ? "The worker hit a usage limit." : (providerFailure ?? "The worker was stopped."),
      );
      yield* updateChat(goalId, threadId, {
        status: "stopped",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "returned",
      });
      if (hit && !madeProgress(thread)) {
        yield* engine
          .dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`goal-cleanup:${yield* randomUUID}`),
            threadId,
          })
          .pipe(Effect.ignoreCause({ log: true }));
      }
      return yield* fillLanes(goalId);
    }

    if (failedTurn) {
      yield* handBack(binding, chat, "retry", "The worker's turn failed after it had started.");
      yield* updateChat(goalId, threadId, {
        status: "failed",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "retry",
      });
      return yield* settleAfterProblem(goalId);
    }

    // 3. The turn completed. A request for a person is honoured only when no check can show
    //    the work is done; otherwise the check decides, whatever the worker wrote.
    if (replyNeedsAttention(lastAssistantReply(thread)) && !info?.verificationCommand) {
      const note = (lastAssistantReply(thread) ?? "").trim().slice(-400);
      yield* handBack(binding, chat, "blocked", `Worker asked for a person: ${note}`);
      yield* updateChat(goalId, threadId, {
        status: "attention",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "attention",
      });
      return yield* settleAfterProblem(goalId);
    }

    // Free the lane now; the check and the candidate record run beside the scheduler.
    yield* updateChat(goalId, threadId, {
      status: "completed",
      completedAt: now,
      waitingForLimit: undefined,
      taskOutcome: undefined,
    });
    yield* fork(
      submitFlow(goalId, threadId).pipe(Effect.catchCause(logFailure("goals.submit-failed"))),
    );
  });

  /** Reserve tasks for free lanes. With no ready task nothing starts and no model turn is spent. */
  const fillQueueLanes: (goalId: GoalId, binding: QueueBinding) => Effect.Effect<void> = Effect.fn(
    "GoalService.fillQueueLanes",
  )(function* (goalId: GoalId, binding: QueueBinding) {
    const first = yield* currentGoal(goalId);
    if (!first || first.status !== "running") return;
    // Submitted work that is waiting to merge is retried whenever the scheduler looks.
    yield* ensureIntegration(goalId);
    for (const chat of first.chats) {
      if (chat.status !== "running" || !chat.claimToken) continue;
      const renewed = yield* queue
        .heartbeat(binding, chat.claimToken)
        .pipe(Effect.catch(() => Effect.succeed(false)));
      if (!renewed) {
        yield* Effect.logWarning("goals.agentqueue-lease-lost", {
          goalId,
          taskId: chat.taskId,
          threadId: chat.threadId,
        });
      }
    }
    // The overseer is deciding how to go on: start nothing until it answers.
    if (first.chats.some((chat) => chat.overseer && chat.status === "running")) return;
    while (true) {
      const goal = yield* currentGoal(goalId);
      const unavailable = goal ? yield* unavailableAgents(goal) : undefined;
      const agentIndex = goal ? nextAgentIndex(goal, new Set(unavailable?.keys())) : undefined;
      if (!goal || agentIndex === undefined) break;
      const now = yield* nowMillis;
      const last = lastStart.get(goalId);
      if (spacing > 0 && last !== undefined && now - last < spacing) break;
      if ((yield* startQueueChat(goal, binding, agentIndex)) !== "started") break;
      lastStart.set(goalId, now);
    }
    yield* settleQueueIfIdle(goalId, binding);
  });

  /**
   * With no worker running: finish the goal if the whole plan is verified and merged, wait
   * while work merges or providers come back, and ask the overseer only when nothing can
   * move on its own. Waiting for dependencies is not a problem and costs no model turn.
   */
  const settleQueueIfIdle = Effect.fn("GoalService.settleQueueIfIdle")(function* (
    goalId: GoalId,
    binding: QueueBinding,
  ) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running") return;
    yield* refreshProgress(goal);
    if (goal.chats.some((chat) => chat.status === "running")) return;

    const status = yield* queue.status(binding).pipe(
      Effect.map(Option.some),
      Effect.catch((error) => queueFailed(goalId, "status", error).pipe(Effect.as(Option.none()))),
    );
    if (Option.isNone(status)) return;
    const { snapshot, ready, candidates } = status.value;

    if (snapshot.counts.total > 0 && snapshot.counts.completed === snapshot.counts.total) {
      const first = yield* queue
        .completion(binding, { runFinalCheck: true })
        .pipe(
          Effect.catch((error) => queueFailed(goalId, "completion", error).pipe(Effect.as(null))),
        );
      if (!first) return;
      if (first.complete) {
        // Re-read at the moment of commitment, so a late event cannot slip through.
        const confirmed = yield* queue
          .completion(binding, { runFinalCheck: false })
          .pipe(Effect.catch(() => Effect.succeed(null)));
        const latest = yield* currentGoal(goalId);
        if (confirmed?.complete && latest?.status === "running") {
          yield* setStatus(
            goalId,
            "complete",
            `All ${first.total} tasks are verified and merged into ${binding.baseBranch}.`,
          );
          yield* refreshProgress({ ...latest, status: "complete" });
        }
        return;
      }
      yield* escalate(goalId, first.reason ?? "The plan is not verifiably complete.");
      return;
    }

    // Work still moving by itself: merging, repairing, or running outside this goal.
    const moving = candidates.some((c) => c.state !== "repair_needed");
    if (moving || snapshot.counts.claimed + snapshot.counts.running > 0) return;

    if (ready > 0) {
      // Something can start but did not: providers are out, spacing, or the chat cap.
      const unavailable = yield* unavailableAgents(goal);
      const next = nextAgentIndex(goal, new Set(unavailable.keys()));
      if (next === undefined && nextAgentIndex(goal) !== undefined) {
        yield* markWaiting(goalId, unavailable);
      } else if (goal.maxChats !== null && chatsSinceStart(goal).length >= goal.maxChats) {
        yield* setStatus(
          goalId,
          "failed",
          `Reached the limit of ${goal.maxChats} chats with ${ready} task(s) still ready.`,
        );
      }
      return;
    }

    // Nothing running, nothing merging, nothing ready, work remains: genuinely stuck.
    const briefing = status.value.problems
      .slice(0, 5)
      .map((p) => `${p.taskId} (${p.status}): ${p.reason ?? "no reason recorded"}`)
      .join("; ");
    yield* escalate(
      goalId,
      status.value.deadlockReason
        ? `${status.value.deadlockReason}${briefing ? ` Problems: ${briefing}` : ""}`
        : `No task can start and none is running.${briefing ? ` Problems: ${briefing}` : ""}`,
    );
  });

  /**
   * After a restart (or on a slow tick) match the queue's claims with this goal's chats.
   * A claim of this goal with no live chat is an abandoned worker: its work is kept on its
   * branch, and the task goes back to the queue.
   */
  const reconcileQueueGoal = Effect.fn("GoalService.reconcileQueueGoal")(function* (
    goal: Goal,
    binding: QueueBinding,
  ) {
    const claims = yield* queue
      .activeClaims(binding)
      .pipe(
        Effect.catch((error) =>
          logQueueError("goals.agentqueue-reconcile-failed")(error).pipe(Effect.as([] as const)),
        ),
      );
    const prefix = `goal-${goal.id}-`;
    for (const claim of claims) {
      if (!claim.workerSessionId?.startsWith(prefix)) continue;
      const owner = goal.chats.find((chat) => chat.claimToken === claim.claimToken);
      const alive = owner && (owner.status === "running" || submitting.has(claim.claimToken));
      const waitingSubmit = owner?.status === "completed" && owner.taskOutcome === undefined;
      if (alive || waitingSubmit) continue;
      yield* Effect.logWarning("goals.agentqueue-orphan-claim", {
        goalId: goal.id,
        taskId: claim.taskId,
      });
      yield* queue
        .release(
          binding,
          claim.claimToken,
          "pending",
          "The worker ended without handing the task back.",
        )
        .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
      yield* queue
        .teardown(binding, claim.worktreePath, claim.branch, false)
        .pipe(Effect.catch(logQueueError("goals.agentqueue-teardown-failed")));
    }
  });

  /** A submission that was cut off by a restart is verified again; its worker is already done. */
  const resumeSubmissions = Effect.fn("GoalService.resumeSubmissions")(function* (goal: Goal) {
    for (const chat of goal.chats) {
      if (
        chat.status === "completed" &&
        chat.claimToken &&
        chat.taskOutcome === undefined &&
        !chat.overseer
      ) {
        yield* fork(
          submitFlow(goal.id, chat.threadId).pipe(
            Effect.catchCause(logFailure("goals.submit-failed")),
          ),
        );
      }
    }
  });

  /**
   * Who should oversee: Chat Agents when that provider is ready (it is not tied to
   * the goal's own usage), otherwise the goal's first agent that can start a chat now.
   */
  const overseerAgent = Effect.fn("GoalService.overseerAgent")(function* (goal: Goal) {
    const now = yield* nowMillis;
    const providers = yield* registry.getProviders.pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ServerProvider>)),
    );
    for (const provider of providers) {
      const model = provider.models[0]?.slug;
      if (provider.driver !== "chatAgents" || !model) continue;
      if (providerBlock(provider, model, now)) continue;
      // A provider that just failed to run an overseer (a locked keyring, a login) is left alone.
      if (
        (goal.pauses ?? []).some(
          (pause) => pause.instanceId === provider.instanceId && Date.parse(pause.until) > now,
        )
      ) {
        continue;
      }
      return {
        agentIndex: 0,
        modelSelection: { instanceId: provider.instanceId, model },
      } as const;
    }
    const unavailable = yield* unavailableAgents(goal);
    const index = goal.agents.findIndex((_, candidate) => !unavailable.has(candidate));
    const agent = goal.agents[index === -1 ? 0 : index];
    return agent
      ? ({ agentIndex: Math.max(index, 0), modelSelection: agent.modelSelection } as const)
      : undefined;
  });

  /** The stuck chats an overseer is shown, numbered from 1 in this order, and may reply to. */
  const problemChatsOf = (goal: Goal) =>
    chatsSinceStart(goal)
      .filter(
        (chat) =>
          !chat.overseer &&
          (chat.status === "failed" || chat.status === "attention" || chat.blockedWork === true),
      )
      .slice(-6);

  /** What the overseer is shown: the goal, why it is stuck, and how chats ended. */
  const overseerBriefing = Effect.fn("GoalService.overseerBriefing")(function* (
    goal: Goal,
    reason: string,
  ) {
    if (goal.agentQueue) {
      const briefing = yield* queue
        .briefing(goal.agentQueue, reason)
        .pipe(Effect.catch((error) => Effect.succeed(`(briefing unavailable: ${error.message})`)));
      const status = yield* queue.status(goal.agentQueue).pipe(Effect.option);
      const candidates = Option.isSome(status)
        ? status.value.candidates
            .map(
              (c) =>
                `  - ${c.taskId}: ${c.state}, ${c.attempts} repair attempt(s)${c.error ? `, ${c.error}` : ""}`,
            )
            .join("\n")
        : "";
      return [
        "You are the overseer of an unattended AgentQueue goal. Workers are assigned tasks by the server and cannot pick their own. The goal cannot move on by itself. Use the structured queue facts below; do not guess from chat history. Never edit, merge, or clean another worker's branch or worktree.",
        "",
        `Goal instructions:\n${goalInstructions(goal)}`,
        "",
        `Why it is stuck: ${reason}`,
        "",
        briefing,
        ...(candidates ? ["", "Submitted work that is not merged:", candidates] : []),
        ...(goal.guidance ? ["", `Your earlier note to the workers: ${goal.guidance}`] : []),
        "",
        "Reply with these sections, each starting on its own line:",
        "OVERSEER: CONTINUE   (almost always) or OVERSEER: STOP (only when nothing an agent can do will help; then say exactly what the person must do)",
        "RETRY: <ids of failed tasks or unmergeable submitted work to try again, separated by spaces>",
        "UNBLOCK: <ids of blocked tasks whose blocker is resolved>",
        "GUIDANCE: <instructions every worker that starts next will read first>",
      ].join("\n");
    }
    const repoRoot = yield* workspaceRootOf(goal.projectId);
    const repo = repoRoot ? yield* repositoryContext.repoContext(repoRoot) : "";
    const problems = problemChatsOf(goal);
    const ended: Array<string> = [];
    for (const [position, chat] of problems.entries()) {
      const reply = lastAssistantReply(yield* readThread(chat.threadId))?.trim() ?? "";
      ended.push(
        `  - CHAT ${position + 1}: ${chat.status}${chat.blockedWork ? " (found no eligible plan chunk)" : ""}: ${reply ? reply.slice(-1200) : "no reply"}`,
      );
    }
    return [
      "You are the overseer of an unattended goal. Agents work on it in separate chats and it is now stuck. Investigate the failure and give workers safe instructions that can get the plan moving again. Use the repository documents below to ground every decision. Workers own their selected plan chunks and worktrees: never take ownership away, edit, overwrite, clean, merge, land, or mark another worker's chunk complete. Treat branches and worktrees as owned until the exact worker process and session are confirmed dead; preserve partial work and use plan-work recovery only after that check.",
      "",
      `Goal instructions:\n${goalInstructions(goal)}`,
      "",
      `Why it is stuck: ${reason}`,
      ...(repo
        ? ["", "About the repository (start of its instruction, spec and plan documents):", repo]
        : []),
      "",
      "How the latest problem chats ended (their last message):",
      ...(ended.length > 0 ? ended : ["  (none)"]),
      ...(goal.guidance ? ["", `Your earlier note to the workers: ${goal.guidance}`] : []),
      "",
      "Your reply is sent to the agents as their instructions, so write it as instructions to them. Use these sections, each starting on its own line:",
      "OVERSEER: CONTINUE   (almost always) or OVERSEER: STOP (only when nothing an agent can do will help, such as a missing login or secret, or an irreversible choice only the person can make; then say exactly what the person must do)",
      "CHAT n: <the message that continues stuck chat n, for example the decision it was waiting for, the fix to apply, or extra work it must do first. Write one for every chat you can unstick.>",
      "GUIDANCE: <the instructions every new worker will read first, for example a fix everyone needs, a decision made, or what to avoid>",
    ].join("\n");
  });

  /** Ask an overseer to get a stuck goal moving. Returns whether one was started. */
  const startOverseer = Effect.fn("GoalService.startOverseer")(function* (
    goal: Goal,
    reason: string,
  ) {
    const agent = yield* overseerAgent(goal);
    if (!agent) return false;
    const text = yield* overseerBriefing(goal, reason);
    const started = yield* openChat(goal, {
      title: GOAL_OVERSEER_TITLE,
      text,
      overseer: true,
      ...agent,
    });
    if (started) {
      stuckReasons.set(goal.id, reason);
      yield* store.update(goal.id, (current) => ({
        ...current,
        overseerRuns: (current.overseerRuns ?? 0) + 1,
        detail: undefined,
      }));
    }
    return started;
  });

  /**
   * The goal cannot go on by itself: ask the overseer first (a limited number of
   * times per start), and give up with `reason` only when that is not possible.
   */
  const escalate = Effect.fn("GoalService.escalate")(function* (goalId: GoalId, reason: string) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running") return;
    const asked = goal.overseerRuns ?? 0;
    if (goal.overseer !== false && asked < MAX_GOAL_OVERSEER_RUNS) {
      if (yield* startOverseer(goal, reason)) return;
    }
    yield* setStatus(goalId, "failed", reason);
  });

  /** Send a stuck chat a new message and mark it working again. Returns whether it was sent. */
  const continueChat = Effect.fn("GoalService.continueChat")(function* (
    goal: Goal,
    chat: GoalChat,
    text: string,
  ) {
    const agent = goal.agents[chat.agentIndex];
    if (!agent) return false;
    watching.set(chat.threadId, { goalId: goal.id, seenRunning: false });
    const sent = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`goal-continue:${yield* randomUUID}`),
        threadId: chat.threadId,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text,
          attachments: [],
        },
        modelSelection: agent.modelSelection,
        runtimeMode: goal.runtimeMode,
        interactionMode: "default",
        createdAt: yield* nowIso,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logFailure("goals.chat-continue-failed")(cause).pipe(Effect.as(false)),
        ),
      );
    if (!sent) {
      watching.delete(chat.threadId);
      return false;
    }
    yield* updateChat(goal.id, chat.threadId, {
      status: "running",
      completedAt: undefined,
      blockedWork: undefined,
    });
    return true;
  });

  /** The overseer's answer: carry on with its note and released chunks, or stop for the person. */
  const finishOverseer = Effect.fn("GoalService.finishOverseer")(function* (
    goal: Goal,
    thread: OrchestrationThread | undefined,
    threadId: ThreadId,
  ) {
    const failed = thread?.latestTurn?.state !== "completed";
    const providerFailure = failed ? providerFailureOf(thread) : undefined;
    yield* updateChat(goal.id, threadId, {
      // A provider that could not even start is not a failed attempt at the goal's problem.
      status: providerFailure !== undefined ? "stopped" : failed ? "failed" : "completed",
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
    });
    if (goal.status !== "running") return;
    const reason = stuckReasons.get(goal.id) ?? "The goal got stuck.";
    stuckReasons.delete(goal.id);
    if (providerFailure !== undefined && thread) {
      // Set that provider aside and ask a healthy one, without spending the overseer budget.
      yield* pauseAgent(
        goal.id,
        { modelSelection: thread.modelSelection } as Goal["agents"][number],
        "errors",
      );
      yield* store.update(goal.id, (current) => ({
        ...current,
        overseerRuns: Math.max((current.overseerRuns ?? 1) - 1, 0),
      }));
      const fresh = yield* currentGoal(goal.id);
      if (fresh && (yield* startOverseer(fresh, reason))) return;
      yield* setStatus(
        goal.id,
        "failed",
        `${reason} No healthy provider could run the overseer (${providerFailure.slice(0, 300)}).`.slice(
          0,
          1500,
        ),
      );
      return;
    }
    const reply = lastAssistantReply(thread);
    const decision = parseOverseerReply(failed ? undefined : reply);
    if (decision.verdict !== "continue") {
      const said = failed
        ? "The overseer could not answer."
        : decision.verdict === "stop"
          ? `The overseer advised stopping: ${(reply ?? "")
              .replace(/^\s*OVERSEER:.*$/gimu, "")
              .trim()
              .slice(0, 600)}`
          : "The overseer gave no clear answer.";
      yield* setStatus(goal.id, "failed", `${reason} ${said}`.slice(0, 1500));
      return;
    }
    // The overseer's words are the prompt: continue each stuck chat it answered, or all of
    // them with the note for new workers when it wrote no message for a chat in particular.
    if (decision.guidance) {
      yield* store.update(goal.id, (current) => ({ ...current, guidance: decision.guidance }));
    }
    if (goal.agentQueue) {
      for (const taskId of decision.retry) {
        yield* queue
          .retryTask(goal.agentQueue, taskId)
          .pipe(Effect.catch(logQueueError("goals.overseer-retry-failed")));
      }
      for (const taskId of decision.unblock) {
        yield* queue
          .unblockTask(goal.agentQueue, taskId)
          .pipe(Effect.catch(logQueueError("goals.overseer-unblock-failed")));
      }
    }
    const targets = goal.agentQueue ? [] : problemChatsOf(goal);
    for (const [position, target] of targets.entries()) {
      const message = decision.chats.get(position + 1) ?? decision.guidance;
      if (!message || target.status === "stopped") continue;
      yield* continueChat(goal, target, message);
    }
    const now = yield* nowIso;
    // A fresh budget and streak: what went wrong has been looked at.
    yield* store.update(goal.id, (current) => ({
      ...current,
      guidance: decision.guidance ?? current.guidance,
      holdStarts: undefined,
      // Chats just continued are working again, so they stay in the count; the rest are looked at.
      reviewedChats: current.chats.length,
      updatedAt: now,
    }));
    yield* fillLanes(goal.id);
  });

  /**
   * Start chats until the lanes are full, the cap is reached, or a start fails;
   * at most one per START_SPACING. Workers select distinct chunks with plan-work.
   */
  const fillLanes = Effect.fn("GoalService.fillLanes")(function* (goalId: GoalId) {
    const first = yield* currentGoal(goalId);
    if (!first || first.status !== "running") return;
    if (first.agentQueue) return yield* fillQueueLanes(goalId, first.agentQueue);
    // Older stored Goal records may still contain this field. Keep their history,
    // but never schedule new work from a Beads queue.
    if (first.useBeads) {
      yield* store.update(goalId, (current) => ({ ...current, useBeads: false }));
      return;
    }
    // The overseer is deciding how to go on: start nothing until it answers.
    if (first.chats.some((chat) => chat.overseer && chat.status === "running")) return;
    while (true) {
      const goal = yield* currentGoal(goalId);
      const unavailable = goal ? yield* unavailableAgents(goal) : undefined;
      const agentIndex = goal ? nextAgentIndex(goal, new Set(unavailable?.keys())) : undefined;
      if (!goal || agentIndex === undefined) break;
      const now = yield* nowMillis;
      const last = lastStart.get(goalId);
      if (spacing > 0 && last !== undefined && now - last < spacing) break;
      if ((yield* startChat(goal, agentIndex)) !== "started") break;
      lastStart.set(goalId, now);
    }
    yield* settleIfIdle(goalId);
  });

  /** A running goal with nothing running and nothing left to start is over, or stuck. */
  const settleIfIdle = Effect.fn("GoalService.settleIfIdle")(function* (goalId: GoalId) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running") return;
    const chats = chatsSinceStart(goal);
    if (chats.some((chat) => chat.status === "running")) return;

    const unavailable = yield* unavailableAgents(goal);
    const next = nextAgentIndex(goal, new Set(unavailable.keys()));
    // Would start something if every provider were back: wait for them, never give up.
    const waitsForProviders = next === undefined && nextAgentIndex(goal) !== undefined;
    if (!waitsForProviders && goal.waitingUntil !== undefined) yield* clearWaiting(goalId);
    if (next !== undefined) {
      return;
    } else if (waitsForProviders) {
      yield* markWaiting(goalId, unavailable);
      return;
    }
    const blocked = chats.filter(
      (chat) => chat.status === "failed" || chat.status === "attention",
    ).length;
    if (goal.holdStarts || blocked >= goal.concurrency) {
      yield* escalate(
        goalId,
        goal.holdStarts
          ? "Stalled: the remaining tasks are blocked and no agent is working to unblock them."
          : "Every chat failed or needs you, so the goal stopped. Open them to see why.",
      );
      return;
    }
    yield* setStatus(
      goalId,
      "failed",
      `Reached the limit of ${goal.maxChats} chats without a GOAL COMPLETE.`,
    );
  });

  /** A goal chat's turn is over for good: record it and decide what happens next. */
  const finishChat = Effect.fn("GoalService.finishChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
    knownLimit?: UsageLimitHit,
  ) {
    watching.delete(threadId);
    const thread = yield* readThread(threadId);
    const before = yield* currentGoal(goalId);
    const chat = before?.chats.find((candidate) => candidate.threadId === threadId);
    if (!before || !chat) {
      return;
    }
    if (chat.overseer) {
      yield* finishOverseer(before, thread, threadId);
      return;
    }
    if (chat.claimToken && before.agentQueue) {
      yield* finishQueueChat(before, before.agentQueue, chat, thread, knownLimit);
      return;
    }
    const interrupted = thread?.latestTurn?.state === "interrupted";
    const failed = knownLimit !== undefined || thread?.latestTurn?.state !== "completed";
    // A usage limit or the person stopping the chat says nothing about the work or the goal.
    const hit = knownLimit ?? (failed && !interrupted ? usageLimitOf(thread) : undefined);
    const stopped = hit !== undefined || interrupted;
    const reply = lastAssistantReply(thread);
    const needsAttention = !failed && replyNeedsAttention(reply);
    const blockedWork = !failed && !needsAttention && replyReportsBlockedWork(reply);
    // The first time a worker gives up, push it to try again on its own before anyone else is asked.
    if (
      (needsAttention || blockedWork) &&
      !chat.nudged &&
      before.status === "running" &&
      (yield* continueChat(before, chat, GOAL_NUDGE_PROMPT))
    ) {
      yield* updateChat(goalId, threadId, { nudged: true });
      return;
    }
    let status: GoalChat["status"] = stopped
      ? "stopped"
      : failed
        ? "failed"
        : needsAttention
          ? "attention"
          : "completed";
    const agent = before.agents[chat.agentIndex];
    if (agent) {
      if (hit) yield* pauseAgent(goalId, agent, "usage-limit", hit.retryAt);
      else if (status === "failed") yield* pauseAgent(goalId, agent, "errors");
      else if (status === "completed") yield* clearPauses(goalId, agent);
    }
    yield* updateChat(goalId, threadId, {
      status,
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
      ...(blockedWork ? { blockedWork: true } : {}),
    });
    if (hit && !madeProgress(thread)) {
      // Nothing was done, so nothing is lost: drop the empty chat and let another provider take over.
      yield* engine
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`goal-cleanup:${yield* randomUUID}`),
          threadId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    // Real progress frees blocked work to start again; a blocked chat means wait for the others.
    if (status === "completed" && !blockedWork && before.holdStarts) {
      yield* store.update(goalId, (goal) => ({ ...goal, holdStarts: undefined }));
    } else if (blockedWork) {
      yield* store.update(goalId, (goal) => ({ ...goal, holdStarts: true }));
    }
    if (before.status !== "running") return;

    if (status === "completed" && !blockedWork && replyReportsGoalComplete(reply)) {
      // One worker finishing its chunk is not the goal finishing: the plan has the last word.
      if (yield* standardPlanFinished(before)) {
        yield* setStatus(goalId, "complete", "An agent reported there is nothing left to do.");
        return;
      }
      yield* Effect.logWarning("goals.goal-complete-marker-ignored", { goalId, threadId });
    }
    const after = yield* currentGoal(goalId);
    const limit = before.stopAfterProblems ?? DEFAULT_GOAL_STOP_AFTER_PROBLEMS;
    if (after && problemStreak(chatsSinceStart(after)) >= limit) {
      yield* escalate(
        goalId,
        `Stopped to protect your usage: the last ${limit} agents in a row could not finish (failed, needed you, or found only blocked work). Agents already working are left to finish.`,
      );
      return;
    }
    yield* fillLanes(goalId);
  });

  /**
   * Continue a chat that hit a usage limit once the limit resets. The command
   * id matches the Auto-resume setting's, so a chat covered by both is only
   * scheduled once.
   */
  const scheduleResume = Effect.fn("GoalService.scheduleResume")(function* (
    threadId: ThreadId,
    session: { readonly updatedAt: string; readonly retryAt?: string | undefined },
  ) {
    const shell = yield* snapshots.getThreadShellById(threadId).pipe(
      Effect.map(Option.getOrUndefined),
      Effect.catchCause(() => Effect.succeed(undefined)),
    );
    if (!shell || shell.usageLimitResume != null) return;
    const now = yield* nowIso;
    yield* engine.dispatch({
      type: "thread.usage-limit-resume.schedule",
      commandId: CommandId.make(`server:usage-limit-auto-resume:${threadId}:${session.updatedAt}`),
      threadId,
      resumeAt: nextUsageLimitRetryAt({
        now,
        attempt: 0,
        ...(session.retryAt !== undefined ? { providerRetryAt: session.retryAt } : {}),
      }),
    });
  });

  const onSessionSet = (event: {
    readonly threadId: ThreadId;
    readonly session: {
      readonly activeTurnId: unknown;
      readonly status: string;
      readonly updatedAt: string;
      readonly retryAt?: string | undefined;
      readonly lastErrorClass?: string | undefined;
    };
  }) =>
    Effect.gen(function* () {
      const watch = watching.get(event.threadId);
      if (!watch) return;
      const { session } = event;
      if (
        session.activeTurnId !== null ||
        session.status === "starting" ||
        session.status === "running"
      ) {
        watch.seenRunning = true;
        yield* updateChat(watch.goalId, event.threadId, { waitingForLimit: undefined });
        return;
      }
      if (session.lastErrorClass === "usage_limit") {
        const limit = { retryAt: session.retryAt };
        const goal = yield* currentGoal(watch.goalId);
        const thread = yield* readThread(event.threadId);
        if (!goal?.autoResume || !madeProgress(thread)) {
          // Not resuming, or nothing worth resuming: record it and free the lane.
          yield* finishChat(watch.goalId, event.threadId, limit);
          return;
        }
        // Work was under way: keep the chat and continue it when the limit resets.
        yield* updateChat(watch.goalId, event.threadId, { waitingForLimit: true });
        const agent =
          goal.agents[
            goal.chats.find((chat) => chat.threadId === event.threadId)?.agentIndex ?? -1
          ];
        if (agent) yield* pauseAgent(goal.id, agent, "usage-limit", session.retryAt);
        yield* scheduleResume(event.threadId, session).pipe(
          Effect.catchCause(logFailure("goals.resume-schedule-failed")),
        );
        // Other providers may take the lane while this one waits.
        yield* fillLanes(watch.goalId);
        return;
      }
      // A quiet session before the turn ever ran is a leftover from before it.
      if (!watch.seenRunning && session.status !== "error") return;
      yield* finishChat(watch.goalId, event.threadId);
    }).pipe(lock.withPermits(1));

  const recover = Effect.gen(function* () {
    for (const stored of yield* store.list) {
      if (stored.useBeads) {
        yield* store.update(stored.id, (current) => ({ ...current, useBeads: false }));
      }
      const goal = (yield* currentGoal(stored.id)) ?? stored;
      // Chats of a stopped goal are still working and still need their result recorded.
      for (const chat of goal.chats) {
        if (chat.status !== "running") continue;
        const thread = yield* readThread(chat.threadId);
        const busy =
          thread?.session !== null &&
          thread?.session !== undefined &&
          (thread.session.activeTurnId !== null ||
            thread.session.status === "starting" ||
            thread.session.status === "running");
        if (thread && !busy && thread.latestTurn !== null) {
          if (thread.session?.lastErrorClass === "usage_limit") {
            watching.set(chat.threadId, { goalId: goal.id, seenRunning: true });
            yield* updateChat(goal.id, chat.threadId, { waitingForLimit: true });
          } else {
            yield* finishChat(goal.id, chat.threadId);
          }
        } else if (thread && !busy) {
          // Created, but the turn never started before the restart.
          if (goal.agentQueue)
            yield* handBack(goal.agentQueue, chat, "pending", "The worker never started.");
          yield* updateChat(goal.id, chat.threadId, {
            status: goal.agentQueue ? "stopped" : "failed",
            completedAt: yield* nowIso,
            ...(goal.agentQueue ? { taskOutcome: "returned" as const } : {}),
          });
        } else {
          watching.set(chat.threadId, { goalId: goal.id, seenRunning: true });
        }
      }
      const settled = (yield* currentGoal(goal.id)) ?? goal;
      if (settled.agentQueue) {
        yield* resumeSubmissions(settled);
        yield* reconcileQueueGoal(settled, settled.agentQueue);
        yield* ensureIntegration(settled.id);
      }
      if (goal.status === "running") yield* fillLanes(goal.id);
    }
  }).pipe(lock.withPermits(1));

  /** Running goals look for room to start the next plan worker. */
  const tick = Effect.gen(function* () {
    for (const goal of yield* store.list) {
      if (goal.status !== "running") continue;
      if (goal.agentQueue) yield* ensureIntegration(goal.id);
      yield* fillLanes(goal.id).pipe(
        lock.withPermits(1),
        Effect.catchCause(logFailure("goals.tick-failed")),
      );
    }
  });

  /**
   * Wakes the scheduler when the queue changes, from any writer: a merge that unlocks
   * dependants, a conflict that needs a repair worker, a task added or released. The
   * slow tick still reconciles, so a missed event only delays work.
   */
  const queueEvents = Effect.forever(
    Effect.sleep("1 second").pipe(
      Effect.andThen(
        Effect.gen(function* () {
          for (const goal of yield* store.list) {
            const binding = goal.agentQueue;
            if (goal.status !== "running" || !binding) continue;
            const batch = yield* queue
              .events(binding, goal.queueEventCursor ?? -1)
              .pipe(Effect.catch(() => Effect.succeed(undefined)));
            if (!batch) continue;
            if (batch.last !== goal.queueEventCursor) {
              yield* store.update(goal.id, (current) => ({
                ...current,
                queueEventCursor: batch.last,
              }));
            }
            if (batch.events.length === 0) continue;
            yield* ensureIntegration(goal.id);
            yield* fillLanes(goal.id).pipe(
              lock.withPermits(1),
              Effect.catchCause(logFailure("goals.event-fill-failed")),
            );
          }
        }).pipe(Effect.catchCause(logFailure("goals.queue-events-failed"))),
      ),
    ),
  );

  const loop = Effect.all(
    [
      queueEvents,
      recover.pipe(Effect.catchCause(logFailure("goals.recovery-failed"))),
      Stream.runForEach(engine.streamDomainEvents, (event) =>
        event.type === "thread.session-set"
          ? onSessionSet(event.payload).pipe(
              Effect.catchCause(logFailure("goals.session-event-failed")),
            )
          : Effect.void,
      ).pipe(Effect.catchCause(logFailure("goals.stream-failed"))),
      Effect.forever(Effect.sleep(TICK_INTERVAL).pipe(Effect.andThen(tick))),
    ],
    { concurrency: "unbounded", discard: true },
  );

  /**
   * Decide how workers get work for a project: AgentQueue when it has a valid active
   * plan (and the person did not ask for standard), otherwise standard `plan-work`.
   * Asking for AgentQueue explicitly never falls back: the answer is "blocked".
   */
  const choose = Effect.fn("GoalService.choose")(function* (input: {
    readonly projectId: Goal["projectId"];
    readonly queueMode: "auto" | "standard" | "agentqueue";
    readonly planPath?: string | undefined;
  }) {
    const root = (yield* workspaceRootOf(input.projectId)) ?? "";
    const raw = root
      ? yield* queue.preview(root, input.planPath?.trim() || undefined).pipe(Effect.option)
      : Option.none();
    const found = Option.getOrUndefined(raw);
    const readiness = found?.readiness ?? "repo-unusable";
    const ready = readiness === "ready";
    const effectiveMode: "agentqueue" | "standard" =
      input.queueMode === "standard"
        ? "standard"
        : input.queueMode === "agentqueue" || ready
          ? "agentqueue"
          : "standard";
    const blocked = input.queueMode === "agentqueue" && !ready;
    const where = found?.planPath ? `${found.planPath} (${found.title ?? "plan"})` : "the project";
    const problem = found?.errors[0] ?? "No plan with tasks was found.";
    const summary =
      input.queueMode === "standard"
        ? "Standard mode: workers pick their own work with plan-work."
        : ready
          ? `AgentQueue: ${where}. ${found!.counts.total} tasks, ${found!.counts.ready} ready now, ${found!.counts.completed} done. Workers are assigned ready tasks only.`
          : blocked
            ? `AgentQueue cannot start: ${problem}`
            : `Standard mode, because ${problem.replace(/\.$/, "")}.`;
    const preview: GoalPlanPreview = {
      readiness,
      effectiveMode,
      blocked,
      summary,
      repoRoot: root,
      baseBranch: found?.baseBranch ?? null,
      planPath: found?.planPath ?? null,
      planId: found?.planId ?? null,
      title: found?.title ?? null,
      errors: found?.errors ?? (root ? [] : ["The project's folder is missing."]),
      warnings: found?.warnings ?? [],
      counts: found?.counts ?? {
        total: 0,
        completed: 0,
        ready: 0,
        waiting: 0,
        active: 0,
        failed: 0,
        withoutVerification: 0,
      },
      legacyOwnedTaskIds: found?.legacyOwnedTaskIds ?? [],
      candidates: found?.candidates ?? [],
    };
    return preview;
  });

  /** The binding (or reason for standard mode) a goal starts with, or why it cannot start. */
  const resolveBinding = Effect.fn("GoalService.resolveBinding")(function* (
    settings: GoalSettings,
  ) {
    const requested = requestedQueueMode(settings);
    if (requested === "standard") {
      return { ok: true as const, agentQueue: undefined, queueReason: undefined };
    }
    const preview = yield* choose({
      projectId: settings.projectId,
      queueMode: requested,
      planPath: settings.planPath,
    });
    if (preview.blocked) return { ok: false as const, message: preview.summary };
    if (preview.effectiveMode === "standard") {
      return {
        ok: true as const,
        agentQueue: undefined,
        queueReason: requested === "auto" ? preview.summary : undefined,
      };
    }
    const bound = yield* queue.bind(preview.repoRoot, preview.planPath ?? undefined).pipe(
      Effect.map(Option.some),
      Effect.catch((error) =>
        Effect.succeed(Option.none<string>()).pipe(
          Effect.tap(() =>
            Effect.logWarning("goals.agentqueue-bind-failed", { message: error.message }),
          ),
          Effect.as(Option.none()),
        ),
      ),
    );
    if (Option.isNone(bound)) {
      return {
        ok: false as const,
        message: `AgentQueue could not import ${preview.planPath ?? "the plan"}.`,
      };
    }
    const importedAt = yield* nowIso;
    return {
      ok: true as const,
      agentQueue: { ...(bound.value as QueueBinding), importedAt },
      queueReason: undefined,
    };
  });

  /**
   * Whether a standard (plan-work) goal may accept an agent's GOAL COMPLETE: only when
   * the project's plan, read from the repository, has nothing left. Goals with no plan
   * keep the old behaviour.
   */
  const standardPlanFinished = Effect.fn("GoalService.standardPlanFinished")(function* (
    goal: Goal,
  ) {
    const root = yield* workspaceRootOf(goal.projectId);
    if (!root) return true;
    const found = yield* queue
      .preview(root, goal.planPath?.trim() || undefined)
      .pipe(Effect.option);
    if (Option.isNone(found)) return false;
    const preview = found.value;
    if (["ready", "legacy-active", "ambiguous"].includes(preview.readiness)) return false;
    if (preview.readiness === "complete" && preview.baseBranch) {
      const unmerged = findUnmergedLegacyBranches(root, preview.baseBranch, preview.planPath);
      if (unmerged.length > 0) return false;
    }
    return true;
  });

  /** Why a setup cannot be saved, or the folder of its project. */
  const checkSettings = Effect.fn("GoalService.checkSettings")(function* (
    given: GoalSettings,
    draft: boolean,
  ) {
    // A draft keeps whatever has been typed so far, so it is saved as it is.
    const settings = draft
      ? { ...given, name: given.name.trim() || ("Untitled goal" as GoalSettings["name"]) }
      : given;
    const problem = draft ? undefined : goalSettingsProblem(settings);
    if (problem) return yield* new OrchestrationDispatchCommandError({ message: problem });
    const projects = yield* snapshots
      .getProjectShells([settings.projectId])
      .pipe(
        Effect.mapError(
          (cause) => new OrchestrationDispatchCommandError({ message: cause.message }),
        ),
      );
    const project = projects[0];
    if (!project) {
      return yield* new OrchestrationDispatchCommandError({
        message: "That project no longer exists.",
      });
    }
    return { ...settings, useBeads: false };
  });

  const create: GoalService["Service"]["create"] = Effect.fn("GoalService.create")(
    function* (input, options) {
      const draft = options?.draft === true;
      const settings = yield* checkSettings(input, draft);
      const now = yield* nowIso;
      // The plan is checked and imported before anything is saved or started, so a goal
      // never exists against an empty, invalid or mismatched queue.
      const binding = draft ? undefined : yield* resolveBinding(settings);
      if (binding && !binding.ok) {
        return yield* new OrchestrationDispatchCommandError({ message: binding.message });
      }
      const goal: Goal = {
        ...settings,
        id: GoalId.make(yield* randomUUID),
        status: draft ? "draft" : "running",
        createdAt: now,
        updatedAt: now,
        chats: [],
        ...(binding?.agentQueue ? { agentQueue: binding.agentQueue } : {}),
        ...(binding?.queueReason ? { queueReason: binding.queueReason } : {}),
      };
      yield* store.add(goal);
      if (!draft) yield* lock.withPermits(1)(fillLanes(goal.id));
      return yield* store.list;
    },
  );

  const update: GoalService["Service"]["update"] = Effect.fn("GoalService.update")(
    function* (id, input, options) {
      const settings = yield* checkSettings(input, options?.draft === true);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const changed = yield* store.update(id, (goal) => ({
            ...goal,
            ...settings,
            updatedAt: now,
          }));
          if (changed?.status === "running") yield* fillLanes(id);
        }),
      );
      return yield* store.list;
    },
  );

  const stop = Effect.fn("GoalService.stop")(function* (id: GoalId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = yield* currentGoal(id);
        if (!goal || goal.status !== "running") return;
        // Chats already working are left alone: they finish, and are recorded as usual.
        yield* setStatus(id, "stopped", "Stopped by you. Agents already working will finish.");
      }),
    );
    return yield* store.list;
  });

  /** Start a goal that is not running: forget old pauses and waiting, then fill the lanes. */
  const startLocked = Effect.fn("GoalService.startLocked")(function* (id: GoalId) {
    const goal = yield* currentGoal(id);
    if (!goal || goal.status === "running") return;
    // Starting (again) re-checks the plan and imports what changed, unless workers of the
    // earlier run are still going and keep the plan they began with.
    if (!(goal.agentQueue && goal.chats.some((chat) => chat.status === "running"))) {
      const binding = yield* resolveBinding(goal);
      if (!binding.ok) {
        yield* setStatus(id, "failed", binding.message.slice(0, 1500));
        return;
      }
      yield* store.update(id, (current) => ({
        ...current,
        agentQueue: binding.agentQueue,
        queueReason: binding.queueReason,
        queueErrors: undefined,
        queueEventCursor: undefined,
        queueProgress: undefined,
      }));
    }
    yield* setStatus(id, "running");
    // Starting by hand is the person saying "try again": forget old pauses and waiting.
    yield* store.update(id, (current) => ({
      ...current,
      holdStarts: undefined,
      pauses: undefined,
      waitingUntil: undefined,
      overseerRuns: undefined,
      reviewedChats: current.chats.length,
    }));
    yield* fillLanes(id);
  });

  const restart = Effect.fn("GoalService.restart")(function* (id: GoalId) {
    yield* lock.withPermits(1)(startLocked(id));
    return yield* store.list;
  });

  const addAgents = Effect.fn("GoalService.addAgents")(function* (id: GoalId, count: number) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = yield* currentGoal(id);
        if (!goal || goal.status === "draft") return;
        const agents = goal.agents.map((agent) => ({ ...agent }));
        // Spread the new agents over the models, so they do not all land on one account.
        for (let added = 0; added < count; added += 1) {
          const agent = agents[added % agents.length]!;
          agent.count = Math.min(agent.count + 1, MAX_GOAL_AGENT_COUNT);
        }
        yield* store.update(id, (current) => ({
          ...current,
          agents,
          concurrency: Math.min(current.concurrency + count, MAX_GOAL_CONCURRENCY),
          maxChats:
            current.maxChats === null
              ? null
              : Math.min(current.maxChats + count, MAX_GOAL_MAX_CHATS),
        }));
        if (goal.status === "running") yield* fillLanes(id);
        else yield* startLocked(id);
      }),
    );
    return yield* store.list;
  });

  const remove = Effect.fn("GoalService.remove")(function* (id: GoalId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        // Deleting a goal forgets it; chats it started keep working as ordinary threads.
        for (const [threadId, watch] of watching) {
          if (watch.goalId === id) watching.delete(threadId);
        }
        lastStart.delete(id);
        yield* store.remove(id);
      }),
    );
    return yield* store.list;
  });

  return GoalService.of({
    previewPlan: choose,
    create,
    update,
    list: store.list,
    stop,
    restart,
    addAgents,
    remove,
    loop,
  });
});

export const layer = Layer.effect(GoalService, make);

/** Service that starts nothing, for contexts with no goals. */
export const layerTest = Layer.succeed(
  GoalService,
  GoalService.of({
    previewPlan: () => Effect.die("previewPlan is not available without a server"),
    create: () => Effect.succeed([]),
    list: Effect.succeed([]),
    update: () => Effect.succeed([]),
    stop: () => Effect.succeed([]),
    restart: () => Effect.succeed([]),
    addAgents: () => Effect.succeed([]),
    remove: () => Effect.succeed([]),
    loop: Effect.void,
  }),
);
