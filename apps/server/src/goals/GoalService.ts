// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off effectFnOpportunity:off
import {
  AgentQueueError,
  AgentQueueService,
  type QueueBinding,
  type ReserveNextResult,
  parseScopeRequests,
} from "../queue/AgentQueueService.ts";
import {
  describeEnvironment,
  findUnmergedLegacyBranches,
  type ReservedTask,
} from "../../../../packages/agent-queue-core/src/index.ts";
/** @module goals/GoalService */
import { OrchestrationDispatchCommandError, ThreadId } from "@t3tools/contracts";
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
  queueResumePrompt,
  queueWorkerPrompt,
  type QueueResumeReason,
  type QueueTaskAssignment,
  requestedQueueMode,
  type GoalPlanPreview,
  goalSettingsProblem,
  goalWorkerTitle,
  MAX_GOAL_ESCALATION_ROUNDS,
  MAX_GOAL_ESCALATION_UNHANDLED,
  MAX_GOAL_STUCK_ESCALATIONS,
  GoalEscalationError,
  type GoalEscalation,
  type GoalEscalationKind,
  type GoalEscalationPacket,
  type GoalEscalationResolveAction,
  type GoalEscalationStatus,
  DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
  problemStreak,
  replyAttentionNote,
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

import * as ProviderRegistryModule from "../provider/ProviderRegistry.ts";
import { GoalThreads, type GoalThreadView } from "./GoalThreads.ts";
import { providerBlock } from "../provider/providerUsageBlock.ts";
import { nextUsageLimitRetryAt, providerUsageLimitFromError } from "./usageLimitText.ts";
import { GoalStore } from "./GoalStore.ts";
import { superviseForever } from "./supervise.ts";

/** Time between one chat starting and the next, per goal. Zero in tests. */
export const StartSpacingMillis = Context.Reference<number>("t3/goals/StartSpacingMillis", {
  defaultValue: () => 15_000,
});

/** How often running goals look for room to start another chat. */
const TICK_INTERVAL = "5 seconds";
const TICK_MILLIS = 5_000;
/**
 * How long a chat whose turn has ended and whose session is idle may stay "running" before the
 * scheduler stops waiting for an event that never came and finishes it from the thread's state.
 */
const IDLE_CHAT_GRACE_MILLIS = 90_000;
/** Report a slow scheduler pass without interrupting operations it still owns. */
const SCHEDULER_PASS_TIMEOUT = "10 minutes";
/** How long the AgentQueue must keep failing, in a row, before a goal is stopped because of it. */
const QUEUE_OUTAGE_MILLIS = 3 * 60_000;
/** How long ready tasks may sit unstartable, with room for agents, before recovery is attempted. */
const STALL_RECOVERY_MILLIS = 2 * 60_000;
/** How often a stalled goal's recovery runs again while the stall lasts. */
const STALL_RECOVERY_REPEAT_MILLIS = 60_000;
/** How long a landed worker's worktree waits for its last checkpoint before it is removed anyway. */
const CHECKPOINT_WAIT_MILLIS = 30_000;
const QUEUE_PROGRESS_HEARTBEAT_MILLIS = 30_000;
const RESOURCE_DELIVERY_BATCH_SIZE = 10;
const RESOURCE_RESULT_MAX_CHARS = 3_000;

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
    /** Problems the overseer answers, optionally for one goal or one status. */
    readonly listEscalations: (filter?: {
      readonly goalId?: GoalId | undefined;
      readonly status?: GoalEscalationStatus | undefined;
    }) => Effect.Effect<ReadonlyArray<GoalEscalation>>;
    readonly readEscalation: (
      id: string,
    ) => Effect.Effect<GoalEscalationPacket, GoalEscalationError>;
    /** Send the held worker a message in its own conversation and resolve the escalation. */
    readonly replyEscalation: (
      id: string,
      message: string,
      by: EscalationActor,
    ) => Effect.Effect<GoalEscalation, GoalEscalationError>;
    readonly resolveEscalation: (
      id: string,
      input: {
        readonly action: GoalEscalationResolveAction;
        readonly note: string;
        readonly guidance?: string | undefined;
        readonly taskId?: string | undefined;
        readonly taskIds?: ReadonlyArray<string> | undefined;
      },
      by: EscalationActor,
    ) => Effect.Effect<void, GoalEscalationError>;
    /** Ask the overseer about a worker chat, or the whole goal when no thread is given. */
    readonly openEscalation: (
      goalId: GoalId,
      threadId: ThreadId | undefined,
      note: string,
    ) => Effect.Effect<GoalEscalation, GoalEscalationError>;
    readonly cancelEscalation: (
      id: string,
      by: EscalationActor,
    ) => Effect.Effect<void, GoalEscalationError>;
    /** Recovers goals after a restart, then reacts to chats finishing. Fork it. */
    readonly loop: Effect.Effect<void>;
  }
>()("t3/goals/GoalService") {}

/**
 * Chats that count against this start: a restart gets a fresh budget. A chat
 * still working always counts, whenever it began.
 */
function chatsSinceStart(goal: Goal): ReadonlyArray<GoalChat> {
  const since = Date.parse(goal.restartedAt ?? goal.createdAt);
  // A finished overseer is not a worker: it never counts toward the budget or the problem streak.
  const reviewed = goal.reviewedChats ?? 0;
  return goal.chats.filter(
    (chat, position) =>
      chat.status === "running" ||
      (!chat.overseer && position >= reviewed && Date.parse(chat.startedAt) >= since),
  );
}

/** An escalation still needs the overseer: it waits for one, or one is working on it. */
const isOpenEscalation = (escalation: GoalEscalation) =>
  escalation.status === "open" || escalation.status === "reviewing";

/** Who acted on an escalation: the overseer agent through MCP, or the person through the app. */
type EscalationActor = "overseer" | "person";

/** Whole-goal escalations raised since the goal last finished a chat, or was started. */
export function stuckSinceProgress(goal: Goal): number {
  const progressAt = Math.max(
    Date.parse(goal.restartedAt ?? goal.createdAt),
    ...goal.chats
      .filter((chat) => chat.status === "completed" && !chat.overseer)
      .map((chat) => Date.parse(chat.completedAt ?? chat.startedAt)),
  );
  return (goal.escalations ?? []).filter(
    (escalation) => escalation.kind === "stuck" && Date.parse(escalation.createdAt) > progressAt,
  ).length;
}

/** The model every default overseer runs on; the account's catalog still decides if it is offered. */
const OVERSEER_GEMINI_MODEL = "gemini-3.8-flash-high";

/** How long a login hold lasts when nothing ends it: starting the goal again clears it first. */
const LOGIN_HOLD_MS = 365 * 24 * 60 * 60 * 1000;

const LOGIN_NEEDED_DETAIL =
  "A provider needs you to sign in or unlock its keyring. Sign in on this computer, then start the goal again.";

/** Short on purpose: the composer of some providers corrupts long pasted prompts. */
function overseerPrompt(goal: Goal, count: number): string {
  return [
    "T3-OVERSEER/1",
    `You are the overseer for T3 Code goal "${goal.name}" (goalId ${goal.id}). ${count} escalation(s) are open.`,
    `Use the T3 tools: call t3_escalation_list with goalId "${goal.id}", then t3_escalation_read for each. Investigate with t3_repo_read_file / t3_repo_search / t3_repo_git (use the projectId and worktreePath in the packet) and t3_thread_read. Then act on every escalation with exactly one of: t3_escalation_reply (send the stuck worker precise instructions in its own conversation, preferred), or t3_escalation_resolve with action retry | unblock | give-up | needs-person. A whole-goal stall has no worker: its packet's queueBriefing lists the blocked and failed tasks, so read why each is held and resolve with unblock or retry and taskIds naming the ones that should run (a task held for a stale or already-settled reason, never an unmet real prerequisite). Use needs-person only when a human must act (missing credential, irreversible product decision); say exactly what they must do. Never edit, merge, clean or take over another worker's branch or worktree. Finish with a one-paragraph summary.`,
    "Change queue state only through the escalation tools; never reset retry counters, force retry unchanged failures, or edit the queue database.",
  ].join("\n");
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

/** Minutes a provider is left alone after failures in a row, growing to an hour. */
const ERROR_BACKOFF_MINUTES = [5, 15, 30, 60] as const;

/** Whether a pause applies to this agent. Antigravity limits are per model; others cover the account. */
const pauseCovers = (pause: GoalProviderPause, instanceId: string, model: string) =>
  pause.instanceId === instanceId && (pause.model === undefined || pause.model === model);

const lastAssistantReply = (thread: GoalThreadView | undefined) =>
  thread?.messages.findLast((message) => message.role === "assistant")?.text;

/** A chat that has said or done nothing yet loses nothing if it is dropped. */
const madeProgress = (thread: GoalThreadView | undefined) =>
  thread !== undefined && thread.madeProgress;

interface UsageLimitHit {
  readonly retryAt?: string | undefined;
}

/** The usage limit a thread's session stopped on, however the provider worded it. */
function usageLimitOf(thread: GoalThreadView | undefined): UsageLimitHit | undefined {
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

const isQueueContention = (error: AgentQueueError) =>
  /database is locked|SQLITE_BUSY/i.test(error.message);

export const make = Effect.gen(function* () {
  const threads = yield* GoalThreads;
  const store = yield* GoalStore;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4().pipe(Effect.orDie);
  const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
  /** Chats still working, and whether their turn has been seen running yet. */
  const watching = new Map<ThreadId, { goalId: GoalId; seenRunning: boolean }>();
  /** Serializes everything that changes a goal's chats, so lanes are never over-filled. */
  const lock = yield* Semaphore.make(1);
  const queue = yield* AgentQueueService;
  /** Background work (submissions, merges) lives as long as the service, and ends with it. */
  const background = yield* Effect.scope;
  const fork = <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.forkIn(effect, background);
  const registry = yield* ProviderRegistryModule.ProviderRegistry;
  const spacing = yield* StartSpacingMillis;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  /** When each goal last started a chat, for spacing starts apart. */
  const lastStart = new Map<GoalId, number>();
  /** Ready tasks that could not start with agents free, per goal: what blocks them, since when. */
  const stallInfo = new Map<
    GoalId,
    { readonly since: string; readonly summary: string; readonly taskIds: ReadonlyArray<string> }
  >();
  const lastStallRecovery = new Map<GoalId, number>();
  /** Chats whose turn ended while background commands still ran, and since when. */
  const deferred = new Map<
    ThreadId,
    {
      goalId: GoalId;
      since: number;
      knownLimit?: UsageLimitHit | undefined;
      turnId?: string | undefined;
    }
  >();

  const logFailure = (message: string) => (cause: Cause.Cause<unknown>) =>
    Cause.hasInterruptsOnly(cause)
      ? Effect.void
      : Effect.logWarning(message, { cause: Cause.pretty(cause) });

  const readThread = (threadId: ThreadId) => threads.read(threadId);

  /** Background commands, watchers or subagents a thread's last turn left running, or null. */
  const backgroundWorkOf = (threadId: ThreadId) =>
    Effect.map(threads.backgroundWork(threadId), (working) =>
      working ? ("working" as const) : null,
    );

  /** Whether a model turn is running or about to (a settled worker woken by its own background job). */
  const sessionBusy = (thread: GoalThreadView | undefined) =>
    thread?.session != null &&
    (thread.session.activeTurnId != null ||
      thread.session.status === "starting" ||
      thread.session.status === "running");

  /** Whether the worker may be treated as finished: no turn, no background command still running. */
  const workerQuiet = Effect.fn("GoalService.workerQuiet")(function* (threadId: ThreadId) {
    const [thread, background] = [yield* readThread(threadId), yield* backgroundWorkOf(threadId)];
    return (
      thread !== undefined &&
      !sessionBusy(thread) &&
      (thread.latestTurn?.state !== "running" || thread.session?.status === "error") &&
      background === null
    );
  });

  const addChat = (goalId: GoalId, chat: GoalChat) =>
    store.update(goalId, (current) => ({
      ...current,
      chats: [...current.chats, chat],
      updatedAt: chat.startedAt,
      // A running goal's detail only ever says it is waiting; it is not waiting now.
      waitingUntil: undefined,
      detail: current.status === "running" ? undefined : current.detail,
    }));

  const updateChat = Effect.fn("GoalService.updateChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
    change: Partial<GoalChat>,
  ) {
    const updatedAt = yield* nowIso;
    return yield* store.update(goalId, (goal) => ({
      ...goal,
      updatedAt,
      chats: goal.chats.map((chat) => (chat.threadId === threadId ? { ...chat, ...change } : chat)),
    }));
  });

  const setStatus = Effect.fn("GoalService.setStatus")(function* (
    goalId: GoalId,
    status: Goal["status"],
    detail?: string,
  ) {
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

  const workspaceRootOf = (projectId: Goal["projectId"]) => threads.workspaceRoot(projectId);

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
            : paused.reason === "login"
              ? "needs you to sign in"
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
      // A login is not a timed failure: it holds until the goal is started again.
      const until =
        reason === "usage-limit"
          ? nextUsageLimitRetryAt({
              now: nowText as never,
              attempt: Math.max(strikes - 1, 0),
              ...(retryAt !== undefined ? { providerRetryAt: retryAt as never } : {}),
            })
          : reason === "login"
            ? (DateTime.formatIso(DateTime.makeUnsafe(now + LOGIN_HOLD_MS)) as never)
            : (DateTime.formatIso(
                DateTime.makeUnsafe(
                  now + ERROR_BACKOFF_MINUTES[Math.min(strikes - 1, 3)]! * 60_000,
                ),
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

  /** Say, on the goal, that ready work is waiting for the machine to have room. */
  const markHostBusy = (goalId: GoalId, reason: string) =>
    store.update(goalId, (goal) => {
      const detail = `Waiting for the machine: ${reason} The goal carries on by itself.`
        .slice(0, 480)
        .trim();
      return goal.hostBusy === true && goal.detail === detail
        ? goal
        : { ...goal, hostBusy: true, detail: detail as never };
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
    // No title generation: the plain title is kept instead of being replaced by a generated one.
    const started = yield* threads
      .launch({
        threadId,
        projectId: goal.projectId,
        title: chat.title,
        text: chat.text,
        modelSelection,
        runtimeMode: goal.runtimeMode,
        branch: chat.branch ?? null,
        worktreePath: chat.worktreePath ?? null,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logFailure("goals.chat-start-failed")(cause).pipe(Effect.as(false)),
        ),
      );
    if (!started) {
      watching.delete(threadId);
      // Back off, so a broken project or provider is not retried on every tick.
      yield* backOff;
      yield* store.update(goal.id, (current) => ({
        ...current,
        chats: current.chats.filter((entry) => entry.threadId !== threadId),
      }));
      yield* threads.remove(threadId).pipe(Effect.ignoreCause({ log: true }));
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

  /** When each goal's current run of queue failures began; cleared by the first success. */
  const queueOutageSince = new Map<GoalId, number>();

  /**
   * An AgentQueue failure is recorded on the goal with its reason. One outage fails several
   * operations within seconds (every tick touches the queue more than once), so the goal is
   * stopped only when the failures have lasted: three in a row AND for a few minutes. A queue that
   * comes back after a blip loses nothing and needs nobody.
   */
  const queueFailed = Effect.fn("GoalService.queueFailed")(function* (
    goalId: GoalId,
    operation: string,
    error: AgentQueueError,
  ) {
    yield* Effect.logWarning("goals.agentqueue-failed", {
      goalId,
      operation,
      message: error.message,
    });
    const now = yield* nowMillis;
    const since = queueOutageSince.get(goalId) ?? now;
    queueOutageSince.set(goalId, since);
    const updated = yield* store.update(goalId, (goal) => ({
      ...goal,
      queueErrors: (goal.queueErrors ?? 0) + 1,
      detail:
        goal.status === "running"
          ? (`AgentQueue ${operation} failed: ${error.message}`.slice(0, 500) as never)
          : goal.detail,
    }));
    if (
      updated?.status === "running" &&
      // A locked queue database is contention, not an outage: the queue is alive and a later
      // tick succeeds once the load drops, so waiting is right and failing the goal is not.
      !isQueueContention(error) &&
      (updated.queueErrors ?? 0) >= 3 &&
      now - since >= QUEUE_OUTAGE_MILLIS
    ) {
      yield* setStatus(
        goalId,
        "failed",
        `AgentQueue ${operation} kept failing for ${Math.round((now - since) / 60_000)} minutes (${updated?.queueErrors} failures in a row): ${error.message}`.slice(
          0,
          1500,
        ),
      );
    }
  });

  const queueHealthy = Effect.fn("GoalService.queueHealthy")(function* (goalId: GoalId) {
    queueOutageSince.delete(goalId);
    yield* store.update(goalId, (goal) =>
      goal.queueErrors === undefined && goal.detail === undefined
        ? goal
        : // The failure note belongs to the outage; a goal that is working again does not keep it.
          {
            ...goal,
            queueErrors: undefined,
            ...(goal.status === "running" && goal.detail?.startsWith("AgentQueue ")
              ? { detail: undefined }
              : {}),
          },
    );
  });

  const logQueueError = (message: string) => (error: AgentQueueError) =>
    Effect.logWarning(message, { operation: error.operation, error: error.message });

  /** Undo a reservation whose chat never started: the task goes back untouched. */
  const returnReservation = Effect.fn("GoalService.returnReservation")(function* (
    binding: QueueBinding,
    claimToken: string,
    worktreePath: string,
    branch: string,
    reason: string,
  ) {
    const released = yield* queue
      .release(binding, claimToken, "pending", reason)
      .pipe(
        Effect.catch((error) =>
          logQueueError("goals.agentqueue-release-failed")(error).pipe(Effect.as(false)),
        ),
      );
    if (!released) return;
    yield* queue
      .teardown(binding, worktreePath, branch, false)
      .pipe(Effect.catch(logQueueError("goals.agentqueue-teardown-failed")));
  });

  /** A lost claim does not prove its earlier writer has stopped using the worktree. */
  const worktreeWritersQuiet = Effect.fn("GoalService.worktreeWritersQuiet")(function* (
    goal: Goal,
    worktreePath: string,
    claimToken: string,
    except?: ThreadId | undefined,
  ) {
    for (const earlier of goal.chats) {
      if (earlier.worktreePath !== worktreePath || earlier.claimToken === claimToken) continue;
      if (except !== undefined && earlier.threadId === except) continue;
      if (!(yield* workerQuiet(earlier.threadId))) return false;
    }
    return true;
  });

  /** The conversation accountable for a task: the latest worker chat that worked on it. */
  const ownerChatOf = (goal: Goal, taskId: string) => {
    const direct = goal.chats.findLast((chat) => !chat.overseer && chat.taskId === taskId);
    if (direct) return direct;
    // A follow-up (T3-FU1) belongs to the conversation that owned its parent.
    const parent = /^(.*)-FU\d+$/u.exec(taskId)?.[1];
    return parent
      ? goal.chats.findLast((chat) => !chat.overseer && chat.taskId === parent)
      : undefined;
  };

  /** Tasks whose owner is out for now, until when: they are not handed to a stranger meanwhile. */
  const ownerWaits = new Map<string, number>();
  const ownersWaitedFor = (goalId: GoalId) =>
    Effect.map(nowMillis, (now) => {
      const ids = new Set<string>();
      for (const [key, until] of ownerWaits) {
        if (until <= now) ownerWaits.delete(key);
        else if (key.startsWith(`${goalId}:`)) ids.add(key.slice(goalId.length + 1));
      }
      return ids as ReadonlySet<string>;
    });

  /** How many times one conversation is brought back onto a task before a fresh worker takes over. */
  const MAX_OWNER_RESUMES = 8;

  /** What the queue knows about a reserved task, as the prompt describes it. */
  const assignmentOf = (binding: QueueBinding, task: ReservedTask, lastFailure: string | null) => {
    const merge = task.repair
      ? {
          state: task.repair.mergeState,
          settledByRule: task.repair.settledByRule,
          integrationBranch: task.repair.integrationBranch,
        }
      : task.waited
        ? {
            state: task.waited.mergeState,
            settledByRule: task.waited.settledByRule,
            integrationBranch: task.waited.integrationBranch,
          }
        : undefined;
    const assignment: QueueTaskAssignment = {
      taskId: task.taskId,
      title: task.title,
      description: task.description,
      verificationCommand: task.verificationCommand,
      worktreePath: task.worktreePath,
      branch: task.branch,
      baseBranch: task.baseBranch,
      planPath: binding.planPath,
      retryCount: task.retryCount,
      lastFailure,
      repair: task.repair?.reason ?? null,
      existingCommits: task.repair ? task.repair.commits : task.existingCommits,
      conflictFiles: task.repair?.files ?? task.waited?.files ?? [],
      allowedPaths: task.scope.length > 0 ? task.allowedPaths : [],
      guards: task.guards,
      generatedPaths: task.generatedPaths,
      environmentNotes: describeEnvironment({
        slot: Number(task.environment.AGENTQUEUE_SLOT ?? 0),
        variables: task.environment,
      }),
      notes: task.notes,
      resources: task.resources,
      ...(Number(process.env.T3_AGENTQUEUE_DEFER_AFTER_SECONDS) > 0
        ? { deferAfterSeconds: Number(process.env.T3_AGENTQUEUE_DEFER_AFTER_SECONDS) }
        : {}),
      ...(merge ? { repairMerge: merge } : {}),
    };
    return assignment;
  };

  /**
   * Bring the conversation that owns a task back onto it, in the same thread with its whole
   * context, instead of starting a stranger. Returns false when that conversation cannot continue
   * (its provider is out, it is gone, it has been resumed too often): then a fresh worker takes the
   * task over from the preserved commits, which is the exception.
   */
  const resumeOwner = Effect.fn("GoalService.resumeOwner")(function* (
    goal: Goal,
    binding: QueueBinding,
    task: ReservedTask,
    owner: GoalChat,
    text: string,
  ) {
    if ((owner.resumes ?? 0) >= MAX_OWNER_RESUMES) return "replace" as const;
    if (task.ownerTurns >= MAX_OWNER_RESUMES * 2) return "replace" as const;
    // The owner is busy with something else right now (another task of its own, a turn still
    // stopping after its settle): the task waits for it a moment instead of going to a stranger.
    const soon = (yield* nowMillis) + 20_000;
    if (owner.status === "running") return { wait: soon } as const;
    const unavailable = yield* unavailableAgents(goal);
    const out = unavailable.get(owner.agentIndex);
    // A provider that is only out for now (a usage limit, a back-off) is waited for: the task keeps
    // its owner. A provider that is gone for good (not installed, signed out) hands the task over.
    if (out?.until !== undefined) return { wait: out.until } as const;
    if (out) return "replace" as const;
    const thread = yield* readThread(owner.threadId);
    if (!thread) return "replace" as const;
    if (!(yield* workerQuiet(owner.threadId))) return { wait: soon } as const;
    // One writer per worktree: nothing else may still be working where the owner is about to.
    if (!(yield* worktreeWritersQuiet(goal, task.worktreePath, task.claimToken, owner.threadId)))
      return { wait: soon } as const;
    // The conversation must be durably in the task's worktree before the model reads the prompt;
    // a prompt that only names the path would run in the deleted original folder.
    const bindFailure = yield* threads
      .bindWorkspace({
        threadId: owner.threadId,
        projectId: goal.projectId,
        key: task.claimToken,
        branch: task.branch,
        worktreePath: task.worktreePath,
      })
      .pipe(
        Effect.as(undefined),
        Effect.catch((error) => Effect.succeed(error.message)),
      );
    if (bindFailure !== undefined) return { workspace: bindFailure } as const;
    const sent = yield* continueChat(goal, owner, text);
    if (!sent) return "replace" as const;
    yield* updateChat(goal.id, owner.threadId, {
      claimToken: task.claimToken,
      taskId: task.taskId,
      worktreePath: task.worktreePath,
      branch: task.branch,
      baseBranch: task.baseBranch,
      settled: false,
      taskOutcome: undefined,
      resourceJobs: undefined,
      attentionNote: undefined,
      landingRetries: 0,
      worktreeRetired: undefined,
      resumes: (owner.resumes ?? 0) + 1,
    });
    yield* queue
      .bindOwner(binding, task.taskId, owner.threadId)
      .pipe(Effect.catch(logQueueError("goals.agentqueue-bind-owner-failed")));
    yield* Effect.logInfo("goals.agentqueue-owner-resumed", {
      goalId: goal.id,
      taskId: task.taskId,
      threadId: owner.threadId,
      resumes: (owner.resumes ?? 0) + 1,
    });
    return "resumed" as const;
  });

  /**
   * Remember why ready tasks could not start, so the goal says it instead of "Agents are working".
   * Nothing is recorded when there was simply nothing ready.
   */
  const noteBlockedTasks = Effect.fn("GoalService.noteBlockedTasks")(function* (
    goalId: GoalId,
    result: ReserveNextResult,
  ) {
    // A candidate merge retried this pass is progress, not a block.
    const blocked = [
      ...result.skipped.filter((entry) => entry.reason !== "INTEGRATION_RETRY"),
      ...result.held,
    ];
    if (blocked.length === 0) {
      stallInfo.delete(goalId);
      return;
    }
    const byReason = new Map<string, string[]>();
    for (const entry of blocked) {
      const text = entry.reason.replace(
        /^SCOPE_CONFLICT \(held by (.+)\)$/u,
        "waiting for files held by $1",
      );
      byReason.set(text, [...(byReason.get(text) ?? []), entry.taskId]);
    }
    const summary = [...byReason]
      .map(([reason, ids]) => `${ids.join(", ")} ${reason}`)
      .join("; ")
      .slice(0, 480);
    const previous = stallInfo.get(goalId);
    if (previous?.summary === summary) return;
    const since = yield* nowIso;
    stallInfo.set(goalId, { since, summary, taskIds: blocked.map((entry) => entry.taskId) });
    yield* Effect.logWarning("goals.agentqueue-ready-tasks-blocked", {
      goalId,
      summary,
      skipped: result.skipped,
      held: result.held,
    });
  });

  /**
   * Reserve a ready task, then give it to its owner. The reservation comes first: when no
   * task is ready this returns "none" without creating a thread or spending a model turn. A
   * task that already has an owner (a repair, a retry, a task that waited for a file) goes back
   * to that same conversation; only a new task, or one whose owner cannot continue, gets a new chat.
   */
  const startQueueChat = Effect.fn("GoalService.startQueueChat")(function* (
    goal: Goal,
    binding: QueueBinding,
    agentIndex: number,
  ) {
    const agent = goal.agents[agentIndex];
    if (!agent) return "none" as const;
    // The machine decides how many workers are sensible, not a fixed count: when memory or load
    // leaves no headroom nothing starts, and nothing is wasted by asking.
    const running = goal.chats.filter((chat) => chat.status === "running" && !chat.overseer).length;
    const admitted = yield* queue.admit(running);
    if (!admitted.ok) {
      yield* markHostBusy(goal.id, admitted.reason ?? "The machine has no spare capacity.");
      return "none" as const;
    }
    if (goal.hostBusy)
      yield* store.update(goal.id, (current) => ({ ...current, hostBusy: undefined }));
    const workerId = `goal-${goal.id}-agent-${agentIndex}-${yield* randomUUID}`;
    const reserved = yield* queue
      .reserveNext(binding, workerId, yield* ownersWaitedFor(goal.id))
      .pipe(
        Effect.map((result) => ({ ok: true as const, result })),
        Effect.catch((error) => Effect.succeed({ ok: false as const, error })),
      );
    if (!reserved.ok) {
      yield* queueFailed(goal.id, "reserve", reserved.error);
      return "failed" as const;
    }
    yield* queueHealthy(goal.id);
    const task = reserved.result.task;
    if (!task) {
      yield* noteBlockedTasks(goal.id, reserved.result);
      return "none" as const;
    }
    stallInfo.delete(goal.id);

    // The queue remembers which conversation owns the task even after that conversation moved on to
    // another task (a follow-up), so ownership is read from there first.
    const owner =
      (task.ownerRef
        ? goal.chats.find((chat) => String(chat.threadId) === task.ownerRef)
        : undefined) ?? ownerChatOf(goal, task.taskId);
    // The owner is still working (or still stopping after a settle): the task waits for it a moment
    // instead of going to a stranger or putting a second writer in the worktree.
    if (owner && (owner.status === "running" || !(yield* workerQuiet(owner.threadId)))) {
      const now = yield* nowMillis;
      ownerWaits.set(`${goal.id}:${task.taskId}`, now + 20_000);
      yield* queue
        .release(binding, task.claimToken, "pending", "Waiting for its owner to be idle.")
        .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
      return "skipped" as const;
    }

    if (!(yield* worktreeWritersQuiet(goal, task.worktreePath, task.claimToken, owner?.threadId))) {
      ownerWaits.set(`${goal.id}:${task.taskId}`, (yield* nowMillis) + 20_000);
      yield* queue
        .release(binding, task.claimToken, "pending", "An earlier worker still uses this worktree.")
        .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
      return "skipped" as const;
    }

    // A task attempted before whose branch already holds commits is not redone: the server
    // runs its checks on those commits first. If they pass, the work is submitted without a
    // worker. Known check failures go straight to their repair worker after an unblock.
    let lastFailure = task.lastFailure;
    if (
      task.retryCount > 0 &&
      task.existingCommits.length > 0 &&
      task.repair === null &&
      !task.needsVerificationRepair
    ) {
      const early = yield* queue
        .submit(binding, {
          taskId: task.taskId,
          claimToken: task.claimToken,
          worktreePath: task.worktreePath,
          branch: task.branch,
          verificationCommand: task.verificationCommand ?? "",
        })
        .pipe(Effect.option);
      if (Option.isSome(early)) {
        const result = early.value;
        if (result.kind === "submitted") {
          yield* Effect.logInfo("goals.agentqueue-resumed-without-worker", { taskId: task.taskId });
          yield* ensureIntegration(goal.id);
          return "started" as const;
        }
        if (
          (result.kind === "verification-failed" || result.kind === "scope-violation") &&
          result.decision.action === "hold"
        ) {
          yield* queue
            .release(binding, task.claimToken, "hold", `${result.error} (${result.decision.why})`, {
              failureClass: result.kind === "verification-failed" ? result.failureClass : "scope",
            })
            .pipe(Effect.catch(logQueueError("goals.agentqueue-hold-failed")));
          return "started" as const;
        }
        if (result.kind === "verification-failed" || result.kind === "scope-violation") {
          lastFailure = result.error;
        }
        if (result.kind === "claim-lost") return "failed" as const;
        if (result.kind === "scope-wait") return "started" as const;
        if (result.kind === "resource-wait") {
          yield* queue
            .release(binding, task.claimToken, "pending", result.message)
            .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
          return "started" as const;
        }
      }
    }

    const assignment = assignmentOf(binding, task, lastFailure);
    let workerAssignment = assignment;
    if (owner) {
      const reason: QueueResumeReason = task.repair
        ? { kind: "conflict" }
        : task.waited
          ? { kind: "scope-wait-cleared", note: task.waited.note }
          : /-FU\d+$/u.test(task.taskId) && owner.taskId !== task.taskId
            ? { kind: "follow-up" }
            : { kind: "retry", failure: lastFailure };
      const resumed = yield* resumeOwner(
        goal,
        binding,
        task,
        owner,
        [queueResumePrompt(assignment, reason), goal.guidance].filter(Boolean).join("\n\n"),
      );
      if (resumed === "resumed") return "started" as const;
      if (typeof resumed === "object" && "workspace" in resumed) {
        // Nothing was sent, so no model turn or retry was spent. The task goes back to pending with
        // its owner held: a claimed task is never reserved again, so keeping the claim would never
        // retry the bind. Nobody else takes it meanwhile, and no chat opens in the repository root.
        yield* Effect.logWarning("goals.agentqueue-owner-rebind-failed", {
          goalId: goal.id,
          taskId: task.taskId,
          threadId: owner.threadId,
          worktreePath: task.worktreePath,
          branch: task.branch,
          detail: resumed.workspace,
        });
        const now = yield* nowMillis;
        ownerWaits.set(`${goal.id}:${task.taskId}`, now + 20_000);
        yield* queue
          .release(
            binding,
            task.claimToken,
            "pending",
            "Could not move its owner into the worktree.",
          )
          .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
        return "skipped" as const;
      }
      if (typeof resumed === "object") {
        // Its provider is out until a known time: leave the task as it is (no penalty, no stranger)
        // and carry on with other work. It is looked at again when the provider is back.
        const now = yield* nowMillis;
        ownerWaits.set(`${goal.id}:${task.taskId}`, Math.min(resumed.wait, now + 15 * 60_000));
        yield* queue
          .release(binding, task.claimToken, "pending", "Waiting for its owner's provider.")
          .pipe(Effect.catch(logQueueError("goals.agentqueue-release-failed")));
        return "skipped" as const;
      }
    }

    if (owner !== undefined || task.ownerTurns > 0) {
      const context = yield* queue.replacementContext(binding, task.taskId).pipe(
        Effect.catch((error) =>
          logQueueError("goals.agentqueue-replacement-context-failed")(error).pipe(
            Effect.as({
              integrationHead: null,
              latestFailure: null,
              earlierFailure: null,
              siblingRepairs: [],
            }),
          ),
        ),
      );
      const jobs = yield* queue
        .resourceJobs(binding, task.taskId)
        .pipe(
          Effect.catch((error) =>
            logQueueError("goals.agentqueue-replacement-jobs-failed")(error).pipe(
              Effect.as({ open: [], finished: [] }),
            ),
          ),
        );
      const jobIds = [...jobs.open, ...jobs.finished.map((job) => job.id)];
      workerAssignment = {
        ...assignment,
        replacementHandoff: {
          integrationBranch: task.baseBranch,
          integrationHead: context.integrationHead,
          latestFailure: context.latestFailure,
          earlierFailure: context.earlierFailure,
          siblingRepairs: context.siblingRepairs,
          outstandingJobs: jobIds.slice(0, 20),
          moreOutstandingJobs: Math.max(0, jobIds.length - 20),
        },
      };
    }

    const threadId = yield* openChat(goal, {
      title: `${task.repair ? "Repair" : "Goal worker"}: ${task.taskId} ${task.title}`.slice(
        0,
        120,
      ),
      text: queueWorkerPrompt(goal, workerAssignment),
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
    yield* queue
      .bindOwner(binding, task.taskId, threadId)
      .pipe(Effect.catch(logQueueError("goals.agentqueue-bind-owner-failed")));
    return "started" as const;
  });

  const startChat = Effect.fn("GoalService.startChat")(function* (goal: Goal, agentIndex: number) {
    return goal.agentQueue
      ? yield* startQueueChat(goal, goal.agentQueue, agentIndex)
      : yield* startStandardChat(goal, agentIndex);
  });

  /**
   * A provider that needs a person at its desktop app: signed out, or its keyring locked so the
   * app never loads. Retrying it unattended only repeats the same failure.
   */
  const isLoginFailure = (error: string) =>
    /APP_SHELL_NOT_LOADED|keyring|\bsign[ -]?in\b|\blog[ -]?in\b/i.test(error);

  /** What a thread's failure says about its provider when it did no work: a login, a keyring, a crash. */
  const providerFailureOf = (thread: GoalThreadView | undefined): string | undefined => {
    if (madeProgress(thread)) return undefined;
    const error = thread?.session?.lastError ?? undefined;
    if (error) return error;
    return thread?.latestTurn?.state === "completed"
      ? undefined
      : "The provider stopped before doing any work.";
  };

  /** Settle a worker's thread with the orchestration engine's own settle command (idempotent id). */
  const settleThread = Effect.fn("GoalService.settleThread")(function* (
    goalId: GoalId,
    threadId: ThreadId,
  ) {
    const settled = yield* threads.settle(threadId).pipe(
      Effect.as(true),
      Effect.catchCause((cause) => logFailure("goals.settle-failed")(cause).pipe(Effect.as(false))),
    );
    if (settled) yield* updateChat(goalId, threadId, { settled: true });
  });

  /** Settle any finished worker thread whose settle did not go through yet (blocked or lost). */
  const settleFinishedChats = Effect.fn("GoalService.settleFinishedChats")(function* (goal: Goal) {
    for (const chat of goal.chats) {
      if (chat.settled || chat.overseer) continue;
      if (chat.taskOutcome !== "submitted" && chat.taskOutcome !== "integrated") continue;
      yield* settleThread(goal.id, chat.threadId);
    }
  });

  /** Goals with an integration pass running, so one goal never integrates twice at once. */
  const integrating = new Set<GoalId>();
  /** Submissions being verified, keyed by claim token. */
  const submitting = new Set<string>();

  /** Where an AgentQueue goal stands, from the queue's own records. */
  const refreshProgress = Effect.fn("GoalService.refreshProgress")(function* (goal: Goal) {
    const binding = goal.agentQueue;
    if (!binding) return;
    const status = yield* queue.status(binding).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        logQueueError("goals.agentqueue-status-failed")(error).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(status)) return;
    const { snapshot, candidates, ready } = status.value;
    const awaiting = candidates.filter((c) => c.state === "pending" || c.state === "conflict");
    const needsRepair = candidates.filter((c) => c.state === "repair_needed").length;
    const waiting = Math.max(snapshot.counts.pending - ready, 0);
    const { resourceProgress, progressFacts } = status.value;
    const ownedRunningChats = goal.chats.filter(
      (chat) =>
        chat.status === "running" &&
        !chat.overseer &&
        chat.taskId !== undefined &&
        chat.claimToken !== undefined &&
        chat.taskOutcome === undefined &&
        chat.waitingForLimit !== true,
    );
    const parkedTaskIds = new Set(
      [
        ...resourceProgress.activeChecks,
        ...resourceProgress.activeJobs,
        ...resourceProgress.resourceWaits,
      ].map((ticket) => ticket.taskId),
    );
    const liveOwnedTaskIds: string[] = [];
    for (const chat of ownedRunningChats) {
      if (chat.taskId && (yield* chatAlive(chat))) liveOwnedTaskIds.push(chat.taskId);
    }
    const running = resourceProgress.inspectionAvailable
      ? new Set(liveOwnedTaskIds.filter((taskId) => !parkedTaskIds.has(taskId))).size
      : 0;
    const waitCandidates: Array<{
      readonly taskId: string;
      readonly since: string;
      readonly reason: "dependencies" | "blocked" | "integration" | "resource" | "results";
    }> = [];
    if (progressFacts.oldestWait) waitCandidates.push(progressFacts.oldestWait);
    for (const ticket of resourceProgress.resourceWaits) {
      waitCandidates.push({
        taskId: ticket.taskId,
        since: DateTime.formatIso(DateTime.makeUnsafe(ticket.enqueuedAt)),
        reason: "resource",
      });
    }
    for (const job of resourceProgress.activeJobs) {
      if (job.state !== "finished-unreported" || job.finishedAt === null) continue;
      waitCandidates.push({
        taskId: job.taskId,
        since: DateTime.formatIso(DateTime.makeUnsafe(job.finishedAt)),
        reason: "results",
      });
    }
    waitCandidates.sort(
      (left, right) =>
        Date.parse(left.since) - Date.parse(right.since) || left.taskId.localeCompare(right.taskId),
    );
    const phaseReason =
      goal.status === "complete"
        ? "complete"
        : !resourceProgress.inspectionAvailable && ownedRunningChats.length > 0
          ? "unknown"
          : resourceProgress.resourceWaits.length > 0
            ? "waiting-resource"
            : resourceProgress.activeJobs.some(
                  (job) => job.state === "running" || job.state === "granted",
                )
              ? "running-resource-job"
              : resourceProgress.activeChecks.length > 0
                ? "verifying"
                : resourceProgress.activeJobs.some((job) => job.state === "finished-unreported")
                  ? "waiting-results"
                  : running > 0
                    ? "implementing"
                    : status.value.publication.state === "pending" ||
                        status.value.publication.state === "blocked"
                      ? "waiting-publication"
                      : awaiting.length > 0
                        ? "waiting-integration"
                        : waiting > 0
                          ? "waiting-dependencies"
                          : needsRepair > 0 ||
                              snapshot.counts.failed > 0 ||
                              snapshot.counts.blocked > 0
                            ? "blocked"
                            : snapshot.counts.total > 0 &&
                                snapshot.counts.completed === snapshot.counts.total
                              ? "waiting-publication"
                              : ready > 0
                                ? "idle"
                                : "idle";
    const deferred =
      awaiting.find((c) => c.state === "pending" && c.error)?.error ??
      (status.value.publication.state === "pending" || status.value.publication.state === "blocked"
        ? (status.value.publication.note ?? undefined)
        : undefined);
    const phase: NonNullable<Goal["queueProgress"]>["phase"] =
      goal.status === "complete"
        ? "complete"
        : running > 0 && !(ready === 0 && waiting > 0 && awaiting.length === 0)
          ? "implementing"
          : running > 0
            ? "waiting-dependencies"
            : awaiting.length > 0
              ? "waiting-integration"
              : snapshot.counts.total > 0 &&
                  snapshot.counts.completed === snapshot.counts.total &&
                  status.value.publication.state !== "published"
                ? "waiting-publication"
                : needsRepair > 0 || snapshot.counts.failed > 0 || snapshot.counts.blocked > 0
                  ? "blocked"
                  : ready > 0
                    ? "idle"
                    : waiting > 0
                      ? "blocked"
                      : "idle";
    const stall = ready > 0 ? stallInfo.get(goal.id) : undefined;
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
      ...(stall
        ? {
            stall: {
              since: stall.since,
              summary: stall.summary,
              taskIds: [...stall.taskIds],
            },
          }
        : {}),
      activity: {
        reason: phaseReason,
        inspectionAvailable: resourceProgress.inspectionAvailable,
        ...(waitCandidates[0]
          ? {
              oldestWait: {
                taskId: waitCandidates[0].taskId,
                since: waitCandidates[0].since,
                reason: waitCandidates[0].reason,
              },
            }
          : {}),
        activeChecks: resourceProgress.activeChecks.map((ticket) => ({
          taskId: ticket.taskId,
          ticketId: ticket.ticketId,
          ...(ticket.checkId !== null ? { checkId: ticket.checkId } : {}),
          state: ticket.state,
          resources: ticket.resources,
          enqueuedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.enqueuedAt)),
          ...(ticket.startedAt !== null
            ? { startedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.startedAt)) }
            : {}),
        })),
        activeJobs: resourceProgress.activeJobs.map((ticket) => ({
          taskId: ticket.taskId,
          ticketId: ticket.ticketId,
          state: ticket.state,
          resources: ticket.resources,
          enqueuedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.enqueuedAt)),
          ...(ticket.startedAt !== null
            ? { startedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.startedAt)) }
            : {}),
          ...(ticket.finishedAt !== null
            ? { finishedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.finishedAt)) }
            : {}),
        })),
        resourceWaits: resourceProgress.resourceWaits.map((ticket) => ({
          taskId: ticket.taskId,
          ticketId: ticket.ticketId,
          ...(ticket.checkId !== null ? { checkId: ticket.checkId } : {}),
          resources: ticket.resources,
          enqueuedAt: DateTime.formatIso(DateTime.makeUnsafe(ticket.enqueuedAt)),
        })),
        omittedChecks: resourceProgress.omittedChecks,
        omittedJobs: resourceProgress.omittedJobs,
        omittedResourceWaits: resourceProgress.omittedResourceWaits,
        completedParentTasks: progressFacts.completedParentTasks,
        completedRepairTasks: progressFacts.completedRepairTasks,
        remainingDependencyTaskIds: progressFacts.remainingDependencyTaskIds,
        omittedDependencyCount: progressFacts.omittedDependencyCount,
      },
    };
    const previous = goal.queueProgress;
    const same =
      previous &&
      JSON.stringify({ ...previous, checkedAt: "" }) === JSON.stringify({ ...next, checkedAt: "" });
    if (same) {
      const lastCheckedAt = Date.parse(previous.checkedAt);
      if (
        Number.isFinite(lastCheckedAt) &&
        (yield* nowMillis) - lastCheckedAt < QUEUE_PROGRESS_HEARTBEAT_MILLIS
      ) {
        return;
      }
    }
    const checkedAt = yield* nowIso;
    yield* store.update(goal.id, (current) => ({
      ...current,
      queueProgress: { ...next, checkedAt },
    }));
  });

  /** Merge every submitted candidate of a goal. Runs beside the scheduler and never blocks it. */
  /**
   * Whether a landed task's worktree may be removed: no worker holds a claim or runs in it, no
   * model turn or background command still uses it, and the last turn's checkpoint is saved
   * (a checkpoint needs the files, and a lookup afterwards would have nothing to read).
   */
  const worktreeFree = Effect.fn("GoalService.worktreeFree")(function* (
    goal: Goal,
    worktreePath: string,
  ) {
    const binding = goal.agentQueue;
    if (binding) {
      const claims = yield* queue.activeClaims(binding).pipe(Effect.option);
      if (
        Option.isNone(claims) ||
        claims.value.some((claim) => claim.worktreePath === worktreePath)
      )
        return false;
    }
    const now = yield* nowMillis;
    for (const chat of goal.chats) {
      if (chat.worktreePath !== worktreePath) continue;
      if (chat.status === "running") return false;
      if (!(yield* workerQuiet(chat.threadId))) return false;
      const thread = yield* readThread(chat.threadId);
      const turnId = thread?.latestTurn?.turnId;
      if (!thread || !turnId || thread.checkpointSaved === null) continue;
      const saved = thread.checkpointSaved;
      const endedAt = Date.parse(chat.completedAt ?? "");
      if (!saved && (Number.isNaN(endedAt) || now - endedAt < CHECKPOINT_WAIT_MILLIS)) {
        return false;
      }
    }
    return true;
  });

  /** Remove a landed task's worktree once it is free; otherwise the sweep tries again later. */
  const retireWorktree = Effect.fn("GoalService.retireWorktree")(function* (
    goalId: GoalId,
    worktreePath: string,
    branch: string,
  ) {
    const goal = yield* currentGoal(goalId);
    const binding = goal?.agentQueue;
    if (!goal || !binding) return;
    if (!(yield* worktreeFree(goal, worktreePath))) return;
    const outcome = yield* queue.teardown(binding, worktreePath, branch, true).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        logQueueError("goals.agentqueue-worktree-cleanup-failed")(error).pipe(
          Effect.as(Option.none()),
        ),
      ),
    );
    if (Option.isNone(outcome) || outcome.value.preserved) return;
    yield* store.update(goalId, (current) => ({
      ...current,
      chats: current.chats.map((chat) =>
        chat.worktreePath === worktreePath ? { ...chat, worktreeRetired: true } : chat,
      ),
    }));
  });

  /** Landed work whose worktree could not be removed yet (still in use, or a checkpoint pending). */
  const sweepLandedWorktrees = Effect.fn("GoalService.sweepLandedWorktrees")(
    function* (goal: Goal) {
      for (const chat of goal.chats) {
        if (chat.taskOutcome !== "integrated" || chat.worktreeRetired) continue;
        if (!chat.worktreePath || !chat.branch) continue;
        yield* retireWorktree(goal.id, chat.worktreePath, chat.branch);
      }
    },
    Effect.catchCause(logFailure("goals.worktree-sweep-failed")),
  );

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
          Effect.asSome,
          Effect.catch((error) =>
            queueFailed(goalId, "integrate", error).pipe(Effect.as(Option.none())),
          ),
        );
        if (Option.isNone(outcome)) return;
        yield* queueHealthy(goalId);
        const result = outcome.value;
        if (result.kind === "landed") {
          progressed = true;
          yield* store.update(goalId, (current) => ({
            ...current,
            chats: current.chats.map((chat) =>
              chat.taskId === candidate.taskId && chat.taskOutcome === "submitted"
                ? { ...chat, taskOutcome: "integrated" as const }
                : chat,
            ),
          }));
          if (candidate.candidateWorktree && candidate.candidateBranch) {
            yield* retireWorktree(goalId, candidate.candidateWorktree, candidate.candidateBranch);
          }
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
    options?: { readonly record?: boolean },
  ) {
    if (!chat.claimToken) return;
    const released = yield* queue
      .release(binding, chat.claimToken, how, reason, options)
      .pipe(
        Effect.catch((error) =>
          logQueueError("goals.agentqueue-release-failed")(error).pipe(Effect.as(false)),
        ),
      );
    if (!released) return;
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
  const submitFlow: (goalId: GoalId, threadId: ThreadId) => Effect.Effect<void> = Effect.fn(
    "GoalService.submitFlow",
  )(function* (goalId: GoalId, threadId: ThreadId) {
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
      // A candidate is never accepted while the worker's tests or commands still run, or while
      // a model turn (a woken worker) is writing to the worktree: back to waiting, work kept.
      if (!(yield* workerQuiet(threadId))) {
        const waitingSince = yield* nowMillis;
        yield* Effect.gen(function* () {
          yield* updateChat(goalId, threadId, { status: "running", completedAt: undefined });
          watching.set(threadId, { goalId, seenRunning: true });
          deferred.set(threadId, { goalId, since: waitingSince });
        }).pipe(lock.withPermits(1));
        return;
      }
      const info = yield* queue
        .taskInfo(binding, chat.taskId!)
        .pipe(Effect.orElseSucceed(() => null));
      const scopeRequests = parseScopeRequests(
        lastAssistantReply(yield* readThread(threadId)) ?? "",
      );
      const outcome = yield* queue
        .submit(binding, {
          taskId: chat.taskId!,
          claimToken: token,
          worktreePath: chat.worktreePath!,
          branch: chat.branch!,
          verificationCommand: info?.verificationCommand ?? "",
          scopeRequests,
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
          // A busy queue database is not a verdict on the work: the tick submits it again, and
          // handing it back made finished workers count as failures (BE1, BE3, BE6 on 2026-10-22).
          if (isQueueContention(outcome.error)) return;
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
            // The commits are kept and checked; what the worker needed a person for stays visible
            // as its own parked task, so the plan cannot finish while it is open.
            if (current.attentionNote) {
              yield* queue
                .addFollowUp(binding, {
                  parentTaskId: chat.taskId!,
                  kind: "decision",
                  // Optional only when the task's own declared checks already passed; with
                  // derived, exempt or no checks nothing shows the objective was met.
                  blocking: !(
                    result.receipt.source === "declared" && result.receipt.state === "passed"
                  ),
                  title: `Needs a person after ${chat.taskId}`,
                  note: current.attentionNote,
                })
                .pipe(Effect.catch(logQueueError("goals.agentqueue-followup-failed")));
            }
            yield* settleThread(goalId, threadId);
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
          case "resolved": {
            // A repair follow-up with nothing to commit: the server itself ran its checks on the
            // integration branch and they pass, so there is nothing left to fix. The follow-up is
            // complete, its parent (if it waited on it) merges again, and no fake commit exists.
            yield* Effect.logInfo("goals.agentqueue-followup-resolved-without-change", {
              goalId,
              taskId: chat.taskId,
              parentTaskId: result.parentTaskId,
              tip: result.tip,
              flaky: result.flaky,
              parentRetried: result.parentRetried,
            });
            yield* updateChat(goalId, threadId, {
              status: "completed",
              taskOutcome: "integrated",
              completedAt: now,
              attentionNote: undefined,
            });
            yield* settleThread(goalId, threadId);
            yield* ensureIntegration(goalId);
            return yield* fillLanes(goalId);
          }
          case "resource-wait": {
            // The checks are waiting for a shared resource: not the worker's problem and not a
            // model turn. The submission is looked at again later with the work untouched.
            yield* Effect.logInfo("goals.agentqueue-checks-waiting-for-resource", {
              goalId,
              taskId: chat.taskId,
              message: result.message,
            });
            yield* fork(
              Effect.sleep("2 minutes").pipe(
                Effect.andThen(submitFlow(goalId, threadId)),
                Effect.catchCause(logFailure("goals.submit-retry-failed")),
              ),
            );
            return;
          }
          case "scope-wait": {
            // Not a failure: a file the task needs is held by another running task. The task is parked
            // with its commits; this same conversation continues when the file is free.
            yield* Effect.logInfo("goals.agentqueue-task-waiting-for-files", {
              goalId,
              taskId: chat.taskId,
              waitsFor: result.waitsFor,
            });
            yield* updateChat(goalId, threadId, { completedAt: now, taskOutcome: "returned" });
            yield* settleThread(goalId, threadId);
            return yield* fillLanes(goalId);
          }
          case "no-changes":
          case "scope-violation":
          case "verification-failed": {
            if (result.kind === "no-changes" && current.attentionNote) {
              // Nothing was committed and the worker says a person must act: the overseer decides first.
              const reason = `Worker asked for a person: ${current.attentionNote}`;
              if (
                yield* raiseEscalation(goalId, {
                  kind: "attention",
                  reason,
                  threadId,
                  taskId: chat.taskId,
                })
              )
                return;
              return yield* giveUpQueueChat(goalId, threadId, { kind: "attention", reason });
            }
            const tries = current.landingRetries ?? 0;
            // The queue recorded this failure and decided whether another attempt can help: the
            // same failure on an unchanged commit must not spend another worker turn.
            const held =
              result.kind !== "no-changes" && result.decision.action === "hold"
                ? result.decision
                : null;
            const feedback =
              result.kind === "no-changes"
                ? NO_COMMIT_PROMPT
                : result.kind === "scope-violation"
                  ? `The server checked which files your commits change and cannot accept some of them:\n${result.error}\nProtected files cannot be changed: revert them (for example \`git checkout ${binding.integrationBranch ?? binding.baseBranch} -- <path>\` or \`git rm\`) and commit. A sensitive file the task truly needs is accepted with a line \`SCOPE-REQUEST: <path>: <why>\` in your final message. Then finish.`
                  : `The server ran the task's check on your commit and it failed:\n${result.error}\nFix it in your worktree, run the check yourself, and commit.`;
            if (
              !held &&
              tries < (result.kind === "no-changes" ? 1 : 2) &&
              fresh.status === "running"
            ) {
              yield* updateChat(goalId, threadId, { landingRetries: tries + 1 });
              if (yield* continueChat(fresh, current, feedback)) return;
            }
            const reasonText =
              result.kind === "no-changes" ? "The worker made no commit." : result.error;
            const reason = held ? `${reasonText} (${held.why})` : reasonText;
            if (
              yield* raiseEscalation(goalId, {
                kind: "repeated-failure",
                reason: reason.slice(0, 4000),
                threadId,
                taskId: chat.taskId,
              })
            )
              return;
            return yield* giveUpQueueChat(goalId, threadId, {
              kind: "retry",
              reason,
              record: result.kind === "no-changes" ? undefined : false,
            });
          }
        }
      }).pipe(lock.withPermits(1));
    }).pipe(Effect.ensuring(Effect.sync(() => submitting.delete(token))));
  });

  /** Too many chats in a row that could not finish their task: stop and say so. */
  const settleAfterProblem: (goalId: GoalId) => Effect.Effect<void> = Effect.fn(
    "GoalService.settleAfterProblem",
  )(function* (goalId: GoalId) {
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
    thread: GoalThreadView | undefined,
    knownLimit: UsageLimitHit | undefined,
  ) {
    const goalId = goal.id;
    const threadId = chat.threadId;
    const now = yield* nowIso;
    const token = chat.claimToken!;

    // 1. Evidence first: what does the queue say about this task right now?
    const info = chat.taskId
      ? yield* queue.taskInfo(binding, chat.taskId).pipe(Effect.orElseSucceed(() => null))
      : null;
    const claims = yield* queue.activeClaims(binding).pipe(Effect.option);
    if (Option.isNone(claims)) {
      deferred.set(threadId, {
        goalId,
        since: yield* nowMillis,
        knownLimit,
        turnId: thread?.latestTurn?.turnId,
      });
      watching.set(threadId, { goalId, seenRunning: true });
      return;
    }
    const holdsClaim = claims.value.some((claim) => claim.claimToken === token);
    if (info?.status === "completed") {
      yield* updateChat(goalId, threadId, {
        status: "completed",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "integrated",
      });
      yield* settleThread(goalId, threadId);
      yield* store.update(goalId, (current) => ({ ...current, holdStarts: undefined }));
      return yield* fillLanes(goalId);
    }
    if (!holdsClaim) {
      const candidates = yield* queue
        .candidates(binding)
        .pipe(Effect.orElseSucceed(() => [] as const));
      const candidate = candidates.find((entry) => entry.taskId === chat.taskId);
      if (candidate && candidate.state !== "repairing") {
        yield* updateChat(goalId, threadId, {
          status: "completed",
          completedAt: now,
          waitingForLimit: undefined,
          taskOutcome: "submitted",
        });
        yield* settleThread(goalId, threadId);
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
    // A turn that never reached an end (the server or its machine went down while it ran) was cut
    // off, not failed: the task goes back without spending a retry.
    const interrupted =
      thread?.latestTurn?.state === "interrupted" || thread?.latestTurn?.state === "running";
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
        yield* threads.remove(threadId).pipe(Effect.ignoreCause({ log: true }));
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

    // 3a. The worker handed commands to the machine's queue (a busy emulator, a long build) and
    //     ended its turn. Nothing is wrong and nothing is finished: the conversation is parked, its
    //     lane is free, and the server brings it back with the results when they exist.
    const handedOver = chat.taskId
      ? yield* queue.resourceJobs(binding, chat.taskId).pipe(Effect.option)
      : Option.none();
    if (
      Option.isSome(handedOver) &&
      (handedOver.value.open.length > 0 ||
        (chat.taskOutcome === "waiting" && handedOver.value.finished.length > 0))
    ) {
      const remainingJobs = [
        ...handedOver.value.open,
        ...handedOver.value.finished.map((job) => job.id),
      ];
      yield* updateChat(goalId, threadId, {
        status: "completed",
        completedAt: now,
        waitingForLimit: undefined,
        taskOutcome: "waiting",
        resourceJobs: remainingJobs,
      });
      yield* settleThread(goalId, threadId);
      yield* Effect.logInfo("goals.agentqueue-worker-parked-on-resource", {
        goalId,
        taskId: chat.taskId,
        jobs: handedOver.value.open,
      });
      return yield* fillLanes(goalId);
    }

    // 3b. The turn completed and nothing is still running. What the worker wrote never decides
    //     the task: its commits and the task's check do (see submitFlow). A request for a person
    //     is kept as a note so it is acted on without throwing the work away.
    const attentionNote = replyAttentionNote(lastAssistantReply(thread));
    if (attentionNote) yield* updateChat(goalId, threadId, { attentionNote });

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

  const quietSince = new Map<ThreadId, { identity: string; since: number }>();

  /**
   * Whether a chat recorded as running is really still working: a model turn is running, its
   * background commands are, or it has only just started or been resumed.
   */
  const chatAlive = Effect.fn("GoalService.chatAlive")(function* (
    chat: GoalChat,
    grace = IDLE_CHAT_GRACE_MILLIS,
  ) {
    const thread = yield* readThread(chat.threadId);
    if (
      !thread ||
      sessionBusy(thread) ||
      chat.waitingForLimit ||
      !thread.latestTurn ||
      !["completed", "interrupted", "error"].includes(thread.latestTurn.state) ||
      (yield* backgroundWorkOf(chat.threadId)) !== null
    ) {
      quietSince.delete(chat.threadId);
      return true;
    }
    const now = yield* nowMillis;
    const identity = `${thread.latestTurn.turnId}:${chat.resumedAt ?? chat.startedAt}`;
    const observed = quietSince.get(chat.threadId);
    if (observed?.identity !== identity) {
      quietSince.set(chat.threadId, { identity, since: now });
      return true;
    }
    return now - observed.since < grace;
  });

  /**
   * A chat recorded as running whose turn ended and whose session is idle is finished from the
   * thread's own state. Normally the session event does that; this is for the event that never
   * came (or was judged stale), so one lost notification cannot hold a task and its files forever.
   */
  const sweepIdleChats = Effect.fn("GoalService.sweepIdleChats")(
    function* (goalId: GoalId, grace = IDLE_CHAT_GRACE_MILLIS) {
      const goal = yield* currentGoal(goalId);
      if (!goal || goal.status !== "running") return;
      for (const chat of goal.chats) {
        if (chat.status !== "running" || chat.overseer || !chat.claimToken) continue;
        if (submitting.has(chat.claimToken)) continue;
        // Chats waiting on background commands are finished by their own watcher.
        if (deferred.has(chat.threadId)) continue;
        if (yield* chatAlive(chat, grace)) continue;
        yield* Effect.gen(function* () {
          // Re-read under the lock: the session event may have finished it meanwhile.
          const fresh = (yield* currentGoal(goalId))?.chats.find(
            (candidate) => candidate.threadId === chat.threadId,
          );
          if (!fresh || fresh.status !== "running" || fresh.claimToken !== chat.claimToken) return;
          if (yield* chatAlive(fresh, grace)) return;
          yield* Effect.logWarning("goals.idle-running-chat-finished", {
            goalId,
            threadId: chat.threadId,
            taskId: chat.taskId,
          });
          yield* finishChat(goalId, chat.threadId, undefined, { vouched: true });
        }).pipe(lock.withPermits(1));
      }
    },
    Effect.catchCause(logFailure("goals.idle-sweep-failed")),
  );

  /**
   * Ready tasks have sat unstartable while agents have room. Find what holds them and put right
   * whatever can safely be put right: finish quiet chats that hold files, and give back claims
   * nobody works on. Nothing is started here and no worker is replaced, so recovery cannot spawn
   * duplicates; whatever is freed is started by the normal scheduler with its normal owner rules.
   */
  const recoverStall = Effect.fn("GoalService.recoverStall")(
    function* (goalId: GoalId) {
      const info = stallInfo.get(goalId);
      if (!info) return;
      const now = yield* nowMillis;
      if (now - Date.parse(info.since) < STALL_RECOVERY_MILLIS) return;
      const last = lastStallRecovery.get(goalId);
      if (last !== undefined && now - last < STALL_RECOVERY_REPEAT_MILLIS) return;
      lastStallRecovery.set(goalId, now);
      yield* Effect.logWarning("goals.queue-stall-recovery", {
        goalId,
        since: info.since,
        summary: info.summary,
      });
      yield* sweepIdleChats(goalId);
      yield* Effect.gen(function* () {
        const goal = yield* currentGoal(goalId);
        if (goal?.agentQueue) yield* reconcileQueueGoal(goal, goal.agentQueue);
        yield* ensureIntegration(goalId);
        yield* fillLanes(goalId);
      }).pipe(lock.withPermits(1));
    },
    Effect.catchCause(logFailure("goals.stall-recovery-failed")),
  );

  /** Reserve tasks for free lanes. With no ready task nothing starts and no model turn is spent. */
  const fillQueueLanes: (goalId: GoalId, binding: QueueBinding) => Effect.Effect<void> = Effect.fn(
    "GoalService.fillQueueLanes",
  )(function* (goalId: GoalId, binding: QueueBinding) {
    const first = yield* currentGoal(goalId);
    if (!first || first.status !== "running") return;
    // Submitted work that is waiting to merge is retried whenever the scheduler looks.
    yield* ensureIntegration(goalId);
    for (const chat of first.chats) {
      if ((chat.status !== "running" && chat.taskOutcome !== "waiting") || !chat.claimToken)
        continue;
      // A lease is renewed for a worker that is working, not for a "running" record whose
      // conversation has gone quiet: renewing that forever would hold its files for good and
      // stop every task that needs them. The idle sweep finishes such a chat; failing that, the
      // lease runs out and the queue takes the claim back.
      if (chat.status === "running" && !(yield* chatAlive(chat))) continue;
      const renewed = yield* queue
        .heartbeat(binding, chat.claimToken)
        .pipe(Effect.orElseSucceed(() => false));
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
    let skips = 0;
    while (true) {
      const goal = yield* currentGoal(goalId);
      const unavailable = goal ? yield* unavailableAgents(goal) : undefined;
      const agentIndex = goal ? nextAgentIndex(goal, new Set(unavailable?.keys())) : undefined;
      if (!goal || agentIndex === undefined) break;
      const now = yield* nowMillis;
      const last = lastStart.get(goalId);
      if (spacing > 0 && last !== undefined && now - last < spacing) break;
      const started = yield* startQueueChat(goal, binding, agentIndex);
      if (started === "skipped" && skips++ < 8) continue;
      if (started !== "started") break;
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
      Effect.asSome,
      Effect.catch((error) => queueFailed(goalId, "status", error).pipe(Effect.as(Option.none()))),
    );
    if (Option.isNone(status)) return;
    const { snapshot, ready, candidates } = status.value;

    if (snapshot.counts.total > 0 && snapshot.counts.completed === snapshot.counts.total) {
      // Merged is not checked: tasks that landed without a passing check are run against the
      // integrated branch now. A failure becomes a blocking repair task, so nothing unchecked is
      // published as finished.
      const audit = yield* queue
        .audit(binding)
        .pipe(Effect.catch((error) => queueFailed(goalId, "audit", error).pipe(Effect.as(null))));
      if (audit && audit.followUps.length > 0) {
        yield* Effect.logWarning("goals.agentqueue-audit-failed", {
          goalId,
          followUps: audit.followUps,
        });
        return yield* fillLanes(goalId);
      }
      // Every task is integrated and verified on the plan's branch. Updating the target
      // branch is a separate step that may have to wait for someone else's checkout.
      const published = yield* queue
        .publish(binding, { reconcileAbandoned: goal.checkoutPolicy !== "wait" })
        .pipe(Effect.catch((error) => queueFailed(goalId, "publish", error).pipe(Effect.as(null))));
      if (!published) return;
      if (published.kind === "pending") {
        yield* Effect.logInfo("goals.agentqueue-publication-pending", {
          goalId,
          cause: published.cause,
          reason: published.reason,
        });
        yield* refreshProgress((yield* currentGoal(goalId)) ?? goal);
        return;
      }
      if (published.kind === "blocked") {
        yield* escalate(goalId, published.reason);
        return;
      }
      yield* queueHealthy(goalId);
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
          .pipe(Effect.orElseSucceed(() => null));
        const latest = yield* currentGoal(goalId);
        if (confirmed?.complete && latest?.status === "running") {
          yield* setStatus(
            goalId,
            "complete",
            `All ${first.total} tasks are verified, integrated and published to ${binding.baseBranch}.`,
          );
          yield* refreshProgress({ ...latest, status: "complete" });
        }
        return;
      }
      // Published later than this check read it, or the target moved again: look again next pass.
      if (first.publication !== "published" && first.finalCheck === "none") return;
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

    // Everything that is stuck waits on the environment (a tool, a guard, a capability, a
    // credential). No worker or overseer can change that, so nobody is asked and the goal does
    // not fail: the held tasks are released by themselves once the environment changes, and
    // meanwhile the reason stays visible on the goal.
    if (status.value.awaitingEnvironment) {
      const held = status.value.problems
        .filter((p) => status.value.environmentTaskIds.includes(p.taskId) || p.failureClass)
        .slice(0, 4)
        .map((p) => `${p.taskId}: ${p.reason ?? p.failureClass}`)
        .join("; ");
      const waitingText = `Waiting for the environment: ${held}`.slice(0, 480);
      if (goal.detail !== waitingText) {
        yield* store.update(goalId, (current) => ({ ...current, detail: waitingText as never }));
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
      const alive =
        owner &&
        (owner.status === "running" ||
          owner.taskOutcome === "waiting" ||
          submitting.has(claim.claimToken));
      const waitingSubmit = owner?.status === "completed" && owner.taskOutcome === undefined;
      if (alive || waitingSubmit) continue;
      // An ended chat can still own a background command; missing liveness is not proof of death.
      if (owner ? !(yield* workerQuiet(owner.threadId)) : claim.workerAlive) continue;
      yield* Effect.logWarning("goals.agentqueue-orphan-claim", {
        goalId: goal.id,
        taskId: claim.taskId,
      });
      const released = yield* queue
        .release(
          binding,
          claim.claimToken,
          "pending",
          "The worker ended without handing the task back.",
        )
        .pipe(
          Effect.catch((error) =>
            logQueueError("goals.agentqueue-release-failed")(error).pipe(Effect.as(false)),
          ),
        );
      if (!released) continue;
      yield* queue
        .teardown(binding, claim.worktreePath, claim.branch, false)
        .pipe(Effect.catch(logQueueError("goals.agentqueue-teardown-failed")));
    }
  });

  /**
   * A submission cut off by a restart or a busy queue database is sent again; its worker is
   * already done. Each claim is submitted once at a time.
   */
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
   * Rotate configured overseer models, skipping unavailable accounts; otherwise use Antigravity
   * accounts, Chat Agents, then a ready goal agent.
   */
  const overseerAgent = Effect.fn("GoalService.overseerAgent")(function* (goal: Goal) {
    const now = yield* nowMillis;
    const providers = yield* registry.getProviders.pipe(
      Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ServerProvider>)),
    );
    // A provider that just failed to run an overseer (a locked keyring, a login, a limit) is left alone.
    const free = ({ instanceId, model }: Goal["agents"][number]["modelSelection"]) =>
      providerBlock(
        providers.find((provider) => provider.instanceId === instanceId),
        model,
        now,
      ) === undefined &&
      !(goal.pauses ?? []).some(
        (pause) => Date.parse(pause.until) > now && pauseCovers(pause, instanceId, model),
      );
    const chosen = goal.overseerAgents ?? [];
    const runs = goal.chats.filter((chat) => chat.overseer).length;
    const turns = <T>(list: ReadonlyArray<T>) =>
      list.map((_, step) => list[(runs + step) % list.length]!);
    const geminiModel = (provider: ServerProvider) =>
      provider.models.length === 0 ||
      provider.models.some((model) => model.slug === OVERSEER_GEMINI_MODEL)
        ? OVERSEER_GEMINI_MODEL
        : provider.models[0]!.slug;
    const accounts = providers
      .filter((provider) => provider.driver === "antigravity")
      .toSorted((left, right) => left.instanceId.localeCompare(right.instanceId));
    const gemini = turns(
      (accounts.length > 1
        ? accounts.filter((provider) => provider.instanceId !== "antigravity")
        : accounts
      ).flatMap((provider) => [{ instanceId: provider.instanceId, model: geminiModel(provider) }]),
    );
    // Chat Agents is a local ACP command now, so it is known by its instance id.
    const chatAgents = providers.flatMap((provider) => {
      const model = provider.models[0]?.slug;
      return (provider.driver === "chatAgents" || provider.instanceId === "chatAgents") && model
        ? [{ instanceId: provider.instanceId, model }]
        : [];
    });
    const candidates = chosen.length > 0 ? turns(chosen) : [...gemini, ...chatAgents];
    const modelSelection = candidates.find(free);
    if (modelSelection) return { agentIndex: 0, modelSelection } as const;
    const unavailable = yield* unavailableAgents(goal);
    const index = goal.agents.findIndex((_, candidate) => !unavailable.has(candidate));
    // Nothing is free and a person must sign in: relaunching would only repeat the failure.
    if (index === -1 && (goal.pauses ?? []).some((pause) => pause.reason === "login"))
      return undefined;
    const agent = goal.agents[index === -1 ? 0 : index];
    return agent
      ? ({ agentIndex: Math.max(index, 0), modelSelection: agent.modelSelection } as const)
      : undefined;
  });

  /**
   * Hold a worker for an overseer. The chat stays running, so its lane and claim stay ours, until
   * the escalation is resolved. Returns false when the worker must be given up on now: escalations
   * are off, the goal is not running, or the worker (or the goal's stuck count) is out of rounds.
   */
  const raiseEscalation: (
    goalId: GoalId,
    input: {
      readonly kind: GoalEscalationKind;
      readonly reason: string;
      readonly threadId?: ThreadId | undefined;
      readonly taskId?: string | undefined;
    },
  ) => Effect.Effect<boolean> = Effect.fn("GoalService.raiseEscalation")(function* (
    goalId: GoalId,
    input: {
      readonly kind: GoalEscalationKind;
      readonly reason: string;
      readonly threadId?: ThreadId | undefined;
      readonly taskId?: string | undefined;
    },
  ) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running" || goal.overseer === false) return false;
    const escalations = goal.escalations ?? [];
    const sameSubject = (escalation: GoalEscalation) =>
      input.threadId !== undefined
        ? escalation.threadId === input.threadId
        : escalation.threadId === undefined && escalation.kind === input.kind;
    if (escalations.some((escalation) => isOpenEscalation(escalation) && sameSubject(escalation)))
      return true;
    const refused =
      input.threadId !== undefined
        ? escalations.filter((escalation) => escalation.threadId === input.threadId).length >=
          MAX_GOAL_ESCALATION_ROUNDS
        : input.kind === "stuck" && stuckSinceProgress(goal) >= MAX_GOAL_STUCK_ESCALATIONS;
    const now = yield* nowIso;
    const id = yield* randomUUID;
    const note = "This worker has used its escalation rounds; the person decides.";
    yield* store.update(goalId, (current) => ({
      ...current,
      updatedAt: now,
      escalations: [
        ...(current.escalations ?? []),
        {
          id,
          kind: input.kind,
          status: refused ? "needs-person" : "open",
          reason: input.reason.slice(0, 4000),
          ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
          ...(input.taskId !== undefined ? { taskId: input.taskId } : {}),
          createdAt: now,
          updatedAt: now,
          rounds: 0,
          ...(refused
            ? { resolution: { action: "needs-person" as const, note, by: "server" as const } }
            : {}),
        },
      ],
    }));
    if (refused) return false;
    if (input.threadId !== undefined) {
      yield* updateChat(goalId, input.threadId, {
        status: "running",
        completedAt: undefined,
        escalationId: id,
      });
    }
    yield* ensureOverseer(goalId);
    return true;
  });

  /** Put an escalation's own status (and what was done about it) on record. */
  const settleEscalation = Effect.fn("GoalService.settleEscalation")(function* (
    goalId: GoalId,
    id: string,
    status: GoalEscalationStatus,
    resolution?: GoalEscalation["resolution"],
  ) {
    const now = yield* nowIso;
    yield* store.update(goalId, (goal) => ({
      ...goal,
      updatedAt: now,
      escalations: (goal.escalations ?? []).map((escalation) =>
        escalation.id === id
          ? {
              ...escalation,
              status,
              updatedAt: now,
              ...(status === "resolved" || status === "cancelled" ? { resolvedAt: now } : {}),
              ...(resolution !== undefined ? { resolution } : {}),
            }
          : escalation,
      ),
    }));
  });

  /**
   * Only one overseer runs per goal. When escalations wait for one and none is running, start it
   * on the best seat; its prompt is short and it reads the escalations through the tools.
   */
  const ensureOverseer: (goalId: GoalId) => Effect.Effect<void> = Effect.fn(
    "GoalService.ensureOverseer",
  )(function* (goalId: GoalId) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running") return;
    if (goal.chats.some((chat) => chat.overseer && chat.status === "running")) return;
    const waiting = (goal.escalations ?? []).filter((escalation) => escalation.status === "open");
    if (waiting.length === 0) return;
    const agent = yield* overseerAgent(goal);
    if (!agent && (goal.pauses ?? []).some((pause) => pause.reason === "login")) {
      // Only a login-held provider is left: the escalations wait for the person, not a relaunch.
      yield* store.update(goalId, (current) => ({
        ...current,
        detail: LOGIN_NEEDED_DETAIL,
      }));
      return;
    }
    if (!agent) {
      for (const escalation of waiting) {
        yield* handOffToPerson(
          goalId,
          escalation,
          "No healthy provider could run the overseer.",
          "server",
        );
      }
      return;
    }
    const threadId = yield* openChat(goal, {
      title: GOAL_OVERSEER_TITLE,
      text: overseerPrompt(goal, waiting.length),
      overseer: true,
      ...agent,
    });
    if (threadId === null) return;
    const now = yield* nowIso;
    const ids = new Set(waiting.map((escalation) => escalation.id));
    yield* store.update(goalId, (current) => ({
      ...current,
      updatedAt: now,
      escalations: (current.escalations ?? []).map((escalation) =>
        ids.has(escalation.id) && escalation.status === "open"
          ? { ...escalation, status: "reviewing", overseerThreadId: threadId, updatedAt: now }
          : escalation,
      ),
    }));
  });

  /**
   * The overseer cannot settle this one: the person decides. A held worker is given up on
   * (keeping its work for the person), a stuck goal stops, and any other escalation waits.
   */
  const handOffToPerson: (
    goalId: GoalId,
    escalation: GoalEscalation,
    note: string,
    by: "overseer" | "server",
  ) => Effect.Effect<void> = Effect.fn("GoalService.handOffToPerson")(function* (
    goalId: GoalId,
    escalation: GoalEscalation,
    note: string,
    by: "overseer" | "server",
  ) {
    const text = note.trim() || "The person must decide.";
    yield* settleEscalation(goalId, escalation.id, "needs-person", {
      action: "needs-person",
      note: text,
      by,
    });
    yield* store.update(goalId, (goal) => ({ ...goal, detail: text.slice(0, 1500) }));
    if (escalation.threadId !== undefined) {
      return yield* giveUpHeldChat(goalId, escalation.threadId, "attention", text);
    }
    if (escalation.kind === "stuck") yield* setStatus(goalId, "failed", text.slice(0, 1500));
  });

  /** A held worker that the overseer or person gave up on: its work is handed back, as before. */
  const giveUpHeldChat: (
    goalId: GoalId,
    threadId: ThreadId,
    outcome: "attention" | "failed",
    reason: string,
  ) => Effect.Effect<void> = Effect.fn("GoalService.giveUpHeldChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
    outcome: "attention" | "failed",
    reason: string,
  ) {
    const goal = yield* currentGoal(goalId);
    const chat = goal?.chats.find((candidate) => candidate.threadId === threadId);
    if (!goal || !chat) return;
    if (goal.agentQueue && chat.claimToken) {
      return yield* giveUpQueueChat(
        goalId,
        threadId,
        outcome === "attention" ? { kind: "attention", reason } : { kind: "retry", reason },
      );
    }
    yield* updateChat(goalId, threadId, {
      status: outcome === "attention" ? "attention" : "failed",
      completedAt: yield* nowIso,
      escalationId: undefined,
    });
    return yield* settleAfterProblem(goalId);
  });

  /**
   * A queue worker's task that cannot go on: an attention request gives its claim back blocked,
   * anything else hands it back for a retry. Its checks, commits and worktree are kept.
   */
  const giveUpQueueChat: (
    goalId: GoalId,
    threadId: ThreadId,
    outcome: {
      readonly kind: "attention" | "retry";
      readonly reason: string;
      readonly record?: boolean | undefined;
    },
  ) => Effect.Effect<void> = Effect.fn("GoalService.giveUpQueueChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
    outcome: {
      readonly kind: "attention" | "retry";
      readonly reason: string;
      readonly record?: boolean | undefined;
    },
  ) {
    const goal = yield* currentGoal(goalId);
    const binding = goal?.agentQueue;
    const current = goal?.chats.find((candidate) => candidate.threadId === threadId);
    if (!goal || !binding || !current) return;
    const now = yield* nowIso;
    if (outcome.kind === "attention") {
      yield* handBack(binding, current, "blocked", outcome.reason);
      yield* updateChat(goalId, threadId, {
        status: "attention",
        completedAt: now,
        taskOutcome: "attention",
        escalationId: undefined,
      });
    } else {
      yield* handBack(
        binding,
        current,
        "retry",
        outcome.reason,
        outcome.record === false ? { record: false } : undefined,
      );
      yield* updateChat(goalId, threadId, {
        status: "failed",
        completedAt: now,
        taskOutcome: "retry",
        escalationId: undefined,
      });
    }
    return yield* settleAfterProblem(goalId);
  });

  /** Too many chats in a row without a stuck escalation resolved: the goal is stuck, ask the overseer. */
  const escalate: (goalId: GoalId, reason: string) => Effect.Effect<void> = Effect.fn(
    "GoalService.escalate",
  )(function* (goalId: GoalId, reason: string) {
    const goal = yield* currentGoal(goalId);
    if (!goal || goal.status !== "running") return;
    if (yield* raiseEscalation(goalId, { kind: "stuck", reason })) return;
    yield* setStatus(goalId, "failed", reason);
  });

  /** Send a stuck chat a new message and mark it working again. Returns whether it was sent. */
  const continueChat = Effect.fn("GoalService.continueChat")(function* (
    goal: Goal,
    chat: GoalChat,
    text: string,
    idempotencyKey?: string,
  ) {
    const agent = goal.agents[chat.agentIndex];
    if (!agent) return false;
    watching.set(chat.threadId, { goalId: goal.id, seenRunning: false });
    const requestedAt = yield* nowIso;
    const sent = yield* threads
      .send({
        threadId: chat.threadId,
        projectId: goal.projectId,
        text,
        modelSelection: agent.modelSelection,
        ...(idempotencyKey !== undefined ? { idempotencyKey } : {}),
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
      resumedAt: requestedAt,
    });
    return true;
  });

  /**
   * An overseer's turn is over. Escalations it left reviewing go back to open, and one left
   * unhandled twice goes to the person. A provider that could not run it is set aside.
   */
  const finishOverseer = Effect.fn("GoalService.finishOverseer")(function* (
    goal: Goal,
    thread: GoalThreadView | undefined,
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
    const fresh = yield* currentGoal(goal.id);
    if (!fresh) return;
    const left = (fresh.escalations ?? []).filter(
      (escalation) => escalation.status === "reviewing" && escalation.overseerThreadId === threadId,
    );
    if (providerFailure !== undefined && thread) {
      yield* pauseAgent(
        goal.id,
        { modelSelection: thread.modelSelection } as Goal["agents"][number],
        isLoginFailure(providerFailure)
          ? "login"
          : usageLimitOf(thread) !== undefined
            ? "usage-limit"
            : "errors",
        usageLimitOf(thread)?.retryAt,
      );
    }
    if (fresh.status !== "running") {
      for (const escalation of left) {
        yield* patchEscalation(goal.id, escalation.id, {
          status: "open",
          overseerThreadId: undefined,
        });
      }
      return;
    }
    for (const escalation of left) {
      if (providerFailure !== undefined) {
        // Not a run that looked at it: no round is spent.
        yield* patchEscalation(goal.id, escalation.id, {
          status: "open",
          overseerThreadId: undefined,
        });
        continue;
      }
      const rounds = escalation.rounds + 1;
      if (rounds >= MAX_GOAL_ESCALATION_UNHANDLED) {
        yield* patchEscalation(goal.id, escalation.id, { rounds });
        yield* handOffToPerson(
          goal.id,
          { ...escalation, rounds },
          "The overseer left this unanswered twice; the person decides.",
          "server",
        );
      } else {
        yield* patchEscalation(goal.id, escalation.id, {
          status: "open",
          overseerThreadId: undefined,
          rounds,
        });
      }
    }
    yield* fillLanes(goal.id);
  });

  const patchEscalation = Effect.fn("GoalService.patchEscalation")(function* (
    goalId: GoalId,
    id: string,
    change: Partial<GoalEscalation>,
  ) {
    const now = yield* nowIso;
    yield* store.update(goalId, (goal) => ({
      ...goal,
      updatedAt: now,
      escalations: (goal.escalations ?? []).map((escalation) =>
        escalation.id === id ? { ...escalation, ...change, updatedAt: now } : escalation,
      ),
    }));
  });

  /** Finds an escalation; `settleable` also refuses one that is already resolved or cancelled. */
  const findEscalation = Effect.fn("GoalService.findEscalation")(function* (
    id: string,
    settleable: boolean = false,
  ) {
    const goals = yield* store.list;
    for (const goal of goals) {
      const escalation = goal.escalations?.find((candidate) => candidate.id === id);
      if (!escalation) continue;
      if (settleable && (escalation.status === "resolved" || escalation.status === "cancelled"))
        return yield* new GoalEscalationError({ reason: "closed" });
      return { goal, escalation };
    }
    return yield* new GoalEscalationError({ reason: "not-found" });
  });

  const readChat = (goal: Goal, escalation: GoalEscalation) =>
    escalation.threadId === undefined
      ? undefined
      : goal.chats.find((chat) => chat.threadId === escalation.threadId);

  /** Everything the overseer needs to decide one escalation. */
  const readEscalation = Effect.fn("GoalService.readEscalation")(function* (id: string) {
    const { goal, escalation } = yield* findEscalation(id);
    const chat = readChat(goal, escalation);
    const thread = chat ? yield* readThread(chat.threadId) : undefined;
    const recentReplies = (thread?.messages ?? [])
      .filter((message) => message.role === "assistant")
      .slice(-3)
      .map((message) => message.text.slice(-3000));
    let queueBriefing: string | undefined;
    if (goal.agentQueue && (chat?.taskId !== undefined || !chat)) {
      queueBriefing = yield* queue.briefing(goal.agentQueue, escalation.reason).pipe(
        Effect.map((text) => text.slice(0, 8000)),
        Effect.orElseSucceed(() => undefined),
      );
    }
    const previous = (goal.escalations ?? []).filter(
      (candidate) =>
        candidate.id !== escalation.id &&
        escalation.threadId !== undefined &&
        candidate.threadId === escalation.threadId,
    );
    return {
      goalId: goal.id,
      goalName: goal.name,
      goalInstructions: goalInstructions(goal),
      projectId: goal.projectId,
      ...(goal.guidance !== undefined ? { guidance: goal.guidance } : {}),
      escalation,
      ...(chat
        ? {
            worker: {
              threadId: chat.threadId,
              ...(chat.taskId !== undefined ? { taskId: chat.taskId } : {}),
              ...(chat.branch !== undefined ? { branch: chat.branch } : {}),
              ...(chat.worktreePath !== undefined ? { worktreePath: chat.worktreePath } : {}),
              ...(chat.baseBranch !== undefined ? { baseBranch: chat.baseBranch } : {}),
              ...(chat.landingRetries !== undefined ? { landingRetries: chat.landingRetries } : {}),
              ...(chat.attentionNote !== undefined ? { attentionNote: chat.attentionNote } : {}),
            },
          }
        : {}),
      recentReplies,
      ...(queueBriefing !== undefined ? { queueBriefing } : {}),
      previous,
    } satisfies GoalEscalationPacket;
  });

  /**
   * Send the held worker the overseer's (or person's) message in its own conversation. The
   * escalation is resolved once the message is sent; otherwise the hold is put back.
   */
  const replyEscalation = Effect.fn("GoalService.replyEscalation")(function* (
    id: string,
    message: string,
    by: EscalationActor,
  ) {
    const { goal, escalation } = yield* findEscalation(id, true);
    const chat = readChat(goal, escalation);
    if (!chat) return yield* new GoalEscalationError({ reason: "no-thread" });
    if (chat.status === "running" && chat.escalationId !== id)
      return yield* new GoalEscalationError({ reason: "not-held" });
    const previousHold = chat.escalationId;
    yield* updateChat(goal.id, chat.threadId, { escalationId: undefined });
    const sent = yield* continueChat(goal, chat, message);
    if (!sent) {
      yield* updateChat(goal.id, chat.threadId, { escalationId: previousHold });
      return yield* new GoalEscalationError({ reason: "not-sent" });
    }
    yield* patchEscalation(goal.id, id, {
      status: "resolved",
      resolvedAt: yield* nowIso,
      rounds: escalation.rounds + 1,
      resolution: { action: "replied", note: message.slice(0, 4000), by },
    });
    return (yield* findEscalation(id)).escalation;
  });

  /** Act on an escalation without a reply: retry, unblock, give up, or hand it to the person. */
  const resolveEscalation = Effect.fn("GoalService.resolveEscalation")(function* (
    id: string,
    input: {
      readonly action: GoalEscalationResolveAction;
      readonly note: string;
      readonly guidance?: string | undefined;
      readonly taskId?: string | undefined;
      readonly taskIds?: ReadonlyArray<string> | undefined;
    },
    by: EscalationActor,
  ) {
    const { goal, escalation } = yield* findEscalation(id, true);
    const chat = readChat(goal, escalation);
    const held = chat !== undefined && chat.escalationId === id;
    const resolution = { action: input.action, note: input.note.slice(0, 4000), by };
    if (input.guidance !== undefined) {
      yield* store.update(goal.id, (current) => ({ ...current, guidance: input.guidance }));
    }
    if (input.action === "retry" || input.action === "unblock") {
      const taskId = input.taskId ?? escalation.taskId ?? chat?.taskId;
      const wholeGoalStall = chat === undefined;
      if (held && chat) {
        // The same conversation carries on with the note as its instructions.
        yield* updateChat(goal.id, chat.threadId, { escalationId: undefined });
        const sent = yield* continueChat(goal, chat, input.note || "Try again.");
        if (!sent) {
          yield* updateChat(goal.id, chat.threadId, { escalationId: id });
          return yield* new GoalEscalationError({ reason: "not-sent" });
        }
      } else if (
        goal.agentQueue &&
        (taskId !== undefined || input.taskIds !== undefined || wholeGoalStall)
      ) {
        const binding = goal.agentQueue;
        // A stall of the whole goal names no task: the held ones are the ones to release.
        const targets =
          input.taskIds ??
          (taskId !== undefined
            ? [taskId]
            : yield* queue.status(binding).pipe(
                Effect.map((status) =>
                  status.problems
                    .filter((p) => p.status === (input.action === "retry" ? "failed" : "blocked"))
                    .map((p) => p.taskId),
                ),
                Effect.mapError(
                  (error) =>
                    new GoalEscalationError({
                      reason: "queue-action-failed",
                      detail: error.message,
                    }),
                ),
              ));
        if (targets.length === 0)
          return yield* new GoalEscalationError({
            reason: "queue-action-failed",
            detail: "No tasks matched the recovery action.",
          });
        yield* Effect.forEach(targets, (target) =>
          (input.action === "retry"
            ? queue.retryTask(binding, target)
            : queue.unblockTask(binding, target)
          ).pipe(
            Effect.mapError(
              (error) =>
                new GoalEscalationError({ reason: "queue-action-failed", detail: error.message }),
            ),
            Effect.flatMap((result) =>
              result.success
                ? Effect.void
                : Effect.fail(
                    new GoalEscalationError({
                      reason: "queue-action-failed",
                      detail: result.message,
                    }),
                  ),
            ),
          ),
        );
      } else if (chat && chat.status !== "running") {
        yield* continueChat(goal, chat, input.note || "Try again.");
      }
      if (escalation.kind === "stuck") {
        // The overseer looked at what failed: those chats no longer hold the goal's lanes.
        yield* store.update(goal.id, (current) => ({
          ...current,
          reviewedChats: current.chats.length,
        }));
      }
      yield* settleEscalation(goal.id, id, "resolved", resolution);
    } else if (input.action === "give-up") {
      yield* settleEscalation(goal.id, id, "resolved", resolution);
      if (held && chat) {
        yield* giveUpHeldChat(goal.id, chat.threadId, "failed", input.note || escalation.reason);
      } else if (escalation.kind === "stuck") {
        yield* setStatus(goal.id, "failed", `${escalation.reason} ${input.note}`.slice(0, 1500));
      }
    } else {
      yield* handOffToPerson(goal.id, escalation, input.note, "overseer");
    }
    yield* fillLanes(goal.id);
  });

  /** A person or agent asks about a worker chat, or the goal as a whole, without a held worker. */
  const openEscalation = Effect.fn("GoalService.openEscalation")(function* (
    goalId: GoalId,
    threadId: ThreadId | undefined,
    note: string,
  ) {
    const goal = yield* currentGoal(goalId);
    if (!goal) return yield* new GoalEscalationError({ reason: "not-found" });
    if (threadId !== undefined && !goal.chats.some((chat) => chat.threadId === threadId))
      return yield* new GoalEscalationError({ reason: "invalid-chat" });
    const now = yield* nowIso;
    const escalation: GoalEscalation = {
      id: yield* randomUUID,
      kind: "manual",
      status: "open",
      reason: note.slice(0, 4000),
      ...(threadId !== undefined ? { threadId } : {}),
      createdAt: now,
      updatedAt: now,
      rounds: 0,
    };
    yield* store.update(goalId, (current) => ({
      ...current,
      updatedAt: now,
      escalations: [...(current.escalations ?? []), escalation],
    }));
    yield* ensureOverseer(goalId);
    return escalation;
  });

  const cancelEscalation = Effect.fn("GoalService.cancelEscalation")(function* (
    id: string,
    by: EscalationActor,
  ) {
    const { goal, escalation } = yield* findEscalation(id, true);
    const chat = readChat(goal, escalation);
    const held = chat !== undefined && chat.escalationId === id;
    yield* settleEscalation(goal.id, id, "cancelled", {
      action: "cancelled",
      note: "",
      by,
    });
    if (held && chat) {
      yield* giveUpHeldChat(goal.id, chat.threadId, "failed", "The escalation was cancelled.");
    }
    yield* fillLanes(goal.id);
  });

  const listEscalations = (
    filter: {
      readonly goalId?: GoalId | undefined;
      readonly status?: GoalEscalationStatus | undefined;
    } = {},
  ) =>
    Effect.map(store.list, (goals) =>
      goals
        .filter((goal) => filter.goalId === undefined || goal.id === filter.goalId)
        .flatMap((goal) => goal.escalations ?? [])
        .filter((escalation) => filter.status === undefined || escalation.status === filter.status),
    );

  /**
   * Start chats until the lanes are full, the cap is reached, or a start fails;
   * at most one per START_SPACING. Workers select distinct chunks with plan-work.
   */
  const fillLanes: (goalId: GoalId) => Effect.Effect<void> = Effect.fn("GoalService.fillLanes")(
    function* (goalId: GoalId) {
      const first = yield* currentGoal(goalId);
      if (!first || first.status !== "running") return;
      yield* ensureOverseer(goalId);
      if (first.agentQueue) return yield* fillQueueLanes(goalId, first.agentQueue);
      // Older stored Goal records may still contain this field. Keep their history,
      // but never schedule new work from a Beads queue.
      if (first.useBeads) {
        yield* store.update(goalId, (current) => ({ ...current, useBeads: false }));
        return;
      }
      // The overseer is deciding how to go on: start nothing until it answers. It may have
      // been opened just now by ensureOverseer, so the goal is read again rather than `first`.
      const deciding = yield* currentGoal(goalId);
      if (deciding?.chats.some((chat) => chat.overseer && chat.status === "running")) return;
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
    },
  );

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

  /** Finish a persisted resource-result delivery, replaying its stable message id after a crash. */
  const reconcileResourceDelivery = Effect.fn("GoalService.reconcileResourceDelivery")(function* (
    goal: Goal,
    chat: GoalChat,
    delivery: NonNullable<GoalChat["resourceDelivery"]>,
  ) {
    const binding = goal.agentQueue;
    if (!binding || !chat.taskId) return "pending" as const;
    const thread = yield* readThread(chat.threadId);
    if (!thread) return "pending" as const;
    const alreadySent = thread.messages.some((message) => message.id === delivery.idempotencyKey);
    if (!alreadySent) {
      if (sessionBusy(thread) || !(yield* workerQuiet(chat.threadId))) return "pending" as const;
      const unavailable = yield* unavailableAgents(goal);
      if (unavailable.has(chat.agentIndex)) return "pending" as const;
      if (!(yield* continueChat(goal, chat, delivery.text, delivery.idempotencyKey)))
        return "pending" as const;
    } else if (thread.latestTurn) {
      const active = sessionBusy(thread) || thread.latestTurn.state === "running";
      yield* updateChat(goal.id, chat.threadId, {
        ...(active ? { status: "running" as const, completedAt: undefined } : {}),
        resumedAt: thread.latestTurn.requestedAt,
      });
    }

    let reportsSucceeded = true;
    for (const jobId of delivery.jobIds) {
      const reported = yield* queue.reportJob(jobId).pipe(
        Effect.as(true),
        Effect.catch((error) =>
          logQueueError("goals.report-job-failed")(error).pipe(Effect.as(false)),
        ),
      );
      reportsSucceeded &&= reported;
    }
    if (!reportsSucceeded) {
      if (alreadySent && !sessionBusy(thread) && thread.latestTurn?.state !== "running") {
        yield* updateChat(goal.id, chat.threadId, {
          status: "completed",
          completedAt: thread.latestTurn?.completedAt ?? (yield* nowIso),
          taskOutcome: "waiting",
        });
        return "finished-pending" as const;
      }
      return "pending" as const;
    }

    const remaining = yield* queue.resourceJobs(binding, chat.taskId).pipe(
      Effect.asSome,
      Effect.catch((error) =>
        logQueueError("goals.resource-job-reconcile-failed")(error).pipe(Effect.as(Option.none())),
      ),
    );
    if (Option.isNone(remaining)) return "pending" as const;
    const remainingIds = [
      ...remaining.value.open,
      ...remaining.value.finished.map((job) => job.id),
    ];
    yield* updateChat(goal.id, chat.threadId, {
      resourceDelivery: undefined,
      resourceResumes: (chat.resourceResumes ?? 0) + 1,
      settled: false,
      ...(remainingIds.length === 0
        ? { taskOutcome: undefined, resourceJobs: undefined }
        : { taskOutcome: "waiting" as const, resourceJobs: remainingIds }),
    });
    return alreadySent && !sessionBusy(thread) && thread.latestTurn?.state !== "running"
      ? ("finished" as const)
      : ("sent" as const);
  });

  /** A goal chat's turn is over for good: record it and decide what happens next. */
  const finishChat = Effect.fn("GoalService.finishChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
    knownLimit?: UsageLimitHit,
    options?: {
      /**
       * The caller saw this conversation run again after it was resumed and go quiet, so the end is
       * the resumed turn's. Without that, an end that predates the last resume is not trusted.
       */
      readonly vouched?: boolean;
    },
  ) {
    watching.delete(threadId);
    const thread = yield* readThread(threadId);
    let before = yield* currentGoal(goalId);
    let chat = before?.chats.find((candidate) => candidate.threadId === threadId);
    if (!before || !chat) {
      return;
    }
    // A delayed session event must not finish a newer model turn or an unknown thread.
    if (
      !thread ||
      sessionBusy(thread) ||
      (thread.latestTurn?.state === "running" && thread.session?.status !== "error") ||
      (chat.claimToken && submitting.has(chat.claimToken))
    ) {
      watching.set(threadId, { goalId, seenRunning: true });
      return;
    }
    // A held worker waits for its escalation; its conversation is decided only once it is resolved.
    if (
      before.escalations?.some(
        (escalation) => escalation.threadId === threadId && isOpenEscalation(escalation),
      )
    )
      return;
    if (chat.resourceDelivery) {
      const delivery = yield* reconcileResourceDelivery(before, chat, chat.resourceDelivery);
      if (delivery === "finished-pending" || delivery === "pending" || delivery === "sent") return;
      before = (yield* currentGoal(goalId)) ?? before;
      chat = before.chats.find((candidate) => candidate.threadId === threadId) ?? chat;
    }
    if (chat.overseer) {
      yield* finishOverseer(before, thread, threadId);
      return;
    }
    // The end of a turn requested before this conversation was last continued (the stop that follows
    // a settle, a late event of the previous turn) says nothing about the turn that is running now.
    const requested = thread?.latestTurn?.requestedAt;
    const completedAt = thread?.latestTurn?.completedAt;
    if (
      options?.vouched !== true &&
      chat.resumedAt &&
      requested &&
      Date.parse(requested) < Date.parse(chat.resumedAt) &&
      // A turn that completed after the resume is the resumed turn, however it was requested.
      !(completedAt && Date.parse(completedAt) >= Date.parse(chat.resumedAt)) &&
      knownLimit === undefined
    ) {
      watching.set(threadId, { goalId, seenRunning: false });
      return;
    }
    // A turn that ended while its background commands (tests, watchers) still run is a pause,
    // not a finish: settling now would stop the session and kill them. The chat stays working
    // until they end; the tick looks again, and a wake-up turn is handled like any other.
    if ((yield* backgroundWorkOf(threadId)) !== null) {
      const now = yield* nowMillis;
      const previous = deferred.get(threadId);
      const since = previous?.since ?? now;
      deferred.set(threadId, {
        goalId,
        since,
        turnId: thread.latestTurn?.turnId,
        knownLimit:
          knownLimit ??
          (previous?.turnId === thread.latestTurn?.turnId ? previous?.knownLimit : undefined),
      });
      watching.set(threadId, { goalId, seenRunning: true });
      if (since === now) {
        yield* Effect.logInfo("goals.finish-deferred-background-work", { goalId, threadId });
      }
      return;
    }
    deferred.delete(threadId);
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
    if (needsAttention || blockedWork) {
      // The worker already had its nudge: the overseer decides before its lane is given up.
      const reason = `${blockedWork ? "Found only blocked work" : "Asked for a person"}:\n${(reply ?? "").slice(-2500)}`;
      if (
        yield* raiseEscalation(goalId, {
          kind: blockedWork ? "blocked" : "attention",
          reason,
          threadId,
        })
      )
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
      yield* threads.remove(threadId).pipe(Effect.ignoreCause({ log: true }));
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

  /** When each limited chat's provider is expected back; the goal continues the chat then. */
  const limitResumes = new Map<ThreadId, number>();

  /** Continue a chat that hit a usage limit once the limit resets. */
  const scheduleResume = Effect.fn("GoalService.scheduleResume")(function* (
    threadId: ThreadId,
    session: { readonly retryAt?: string | undefined },
  ) {
    const now = yield* nowIso;
    limitResumes.set(
      threadId,
      Date.parse(
        nextUsageLimitRetryAt({
          now,
          attempt: 0,
          ...(session.retryAt !== undefined ? { providerRetryAt: session.retryAt } : {}),
        }),
      ),
    );
  });

  /** Continue limited chats whose reset time has passed. A chat limited again is scheduled again. */
  const resumeLimitedChats = Effect.gen(function* () {
    const now = yield* nowMillis;
    for (const [threadId, resumeAt] of limitResumes) {
      if (resumeAt > now) continue;
      limitResumes.delete(threadId);
      const watch = watching.get(threadId);
      const goal = watch ? yield* currentGoal(watch.goalId) : undefined;
      const chat = goal?.chats.find(
        (candidate) =>
          candidate.threadId === threadId &&
          candidate.status === "running" &&
          candidate.waitingForLimit === true,
      );
      if (!goal || !chat || goal.status !== "running") continue;
      if (sessionBusy(yield* readThread(threadId))) continue;
      yield* continueChat(goal, chat, "Continue where you left off.");
    }
  }).pipe(Effect.catchCause(logFailure("goals.resume-limited-failed")));

  const onSessionSet = Effect.fn("GoalService.onSessionSet")(function* (event: {
    readonly threadId: ThreadId;
  }) {
    const watch = watching.get(event.threadId);
    if (!watch) return;
    const view = yield* readThread(event.threadId);
    if (!view) return;
    const { session } = view;
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
        goal.agents[goal.chats.find((chat) => chat.threadId === event.threadId)?.agentIndex ?? -1];
      if (agent) yield* pauseAgent(goal.id, agent, "usage-limit", session.retryAt);
      yield* scheduleResume(event.threadId, session);
      // Other providers may take the lane while this one waits.
      yield* fillLanes(watch.goalId);
      return;
    }
    // A quiet session before the turn ever ran is a leftover from before it.
    if (!watch.seenRunning && session.status !== "error") return;
    // The turn was seen running after the last resume and has now ended: it is that turn's end.
    yield* finishChat(watch.goalId, event.threadId, undefined, { vouched: true });
  }).pipe(lock.withPermits(1));

  /** Chats that paused on background commands are finished once those end and the model is idle. */
  const finishDeferred = Effect.gen(function* () {
    for (const [threadId, entry] of deferred) {
      const goal = yield* currentGoal(entry.goalId);
      if (!goal?.chats.some((chat) => chat.threadId === threadId && chat.status === "running")) {
        deferred.delete(threadId);
        continue;
      }
      const thread = yield* readThread(threadId);
      if (sessionBusy(thread)) continue;
      if ((yield* backgroundWorkOf(threadId)) !== null) {
        continue;
      }
      const limit = entry.turnId === thread?.latestTurn?.turnId ? entry.knownLimit : undefined;
      yield* finishChat(entry.goalId, threadId, limit, { vouched: true }).pipe(lock.withPermits(1));
    }
  }).pipe(Effect.catchCause(logFailure("goals.finish-deferred-failed")));

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
            yield* scheduleResume(chat.threadId, thread.session);
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

  /**
   * Runs the stored resource jobs that can run now, and brings each parked conversation back with
   * the result of what it queued. The conversation is the one that asked, in its own thread.
   */
  const deliverJobResults = Effect.fn("GoalService.deliverJobResults")(function* (goalId: GoalId) {
    const goal = yield* currentGoal(goalId);
    const binding = goal?.agentQueue;
    if (!goal || !binding || goal.status !== "running") return;
    yield* queue.runJobs(binding).pipe(Effect.catch(logQueueError("goals.resource-jobs-failed")));
    for (const storedChat of goal.chats) {
      const fresh = (yield* currentGoal(goalId)) ?? goal;
      const chat = fresh.chats.find((candidate) => candidate.threadId === storedChat.threadId);
      if (!chat?.taskId) continue;
      if (chat.resourceDelivery) {
        const result = yield* reconcileResourceDelivery(fresh, chat, chat.resourceDelivery);
        if (result === "finished") {
          yield* finishChat(goalId, chat.threadId, undefined, { vouched: true });
        }
        if (result === "sent" || result === "finished") {
          yield* Effect.logInfo("goals.agentqueue-resource-results-delivered", {
            goalId,
            taskId: chat.taskId,
            jobs: chat.resourceDelivery.jobIds,
          });
        }
        continue;
      }
      if (chat.taskOutcome !== "waiting" || chat.status === "running") continue;
      const jobs = yield* queue.resourceJobs(binding, chat.taskId).pipe(Effect.option);
      if (Option.isNone(jobs) || jobs.value.open.length > 0 || jobs.value.finished.length === 0) {
        continue;
      }
      const unavailable = yield* unavailableAgents(fresh);
      if (unavailable.has(chat.agentIndex)) continue;
      if (!(yield* workerQuiet(chat.threadId))) continue;
      const info = yield* queue
        .taskInfo(binding, chat.taskId)
        .pipe(Effect.orElseSucceed(() => null));
      const text = queueResumePrompt(
        {
          taskId: chat.taskId,
          title: info?.title ?? chat.taskId,
          description: info?.description ?? null,
          verificationCommand: info?.verificationCommand ?? null,
          worktreePath: chat.worktreePath ?? "",
          branch: chat.branch ?? "",
          baseBranch: chat.baseBranch ?? binding.baseBranch,
          planPath: binding.planPath,
          retryCount: info?.retryCount ?? 0,
          lastFailure: null,
          repair: null,
        },
        {
          kind: "resource-results",
          results: jobs.value.finished
            .slice(0, RESOURCE_DELIVERY_BATCH_SIZE)
            .map((job) => job.summary.slice(0, RESOURCE_RESULT_MAX_CHARS)),
        },
      );
      const jobIds = jobs.value.finished
        .slice(0, RESOURCE_DELIVERY_BATCH_SIZE)
        .map((job) => job.id);
      const delivery = {
        idempotencyKey: `resource-results:${chat.threadId}:${jobIds.join(",")}`,
        jobIds,
        text,
      };
      yield* updateChat(goalId, chat.threadId, {
        resourceDelivery: delivery,
      });
      const pendingGoal = (yield* currentGoal(goalId)) ?? fresh;
      const pendingChat =
        pendingGoal.chats.find((candidate) => candidate.threadId === chat.threadId) ?? chat;
      const result = yield* reconcileResourceDelivery(pendingGoal, pendingChat, delivery);
      if (result === "finished") {
        yield* finishChat(goalId, chat.threadId, undefined, { vouched: true });
      }
      if (result === "sent" || result === "finished") {
        yield* Effect.logInfo("goals.agentqueue-resource-results-delivered", {
          goalId,
          taskId: chat.taskId,
          jobs: jobIds,
        });
      }
    }
  });

  /** Running goals look for room to start the next plan worker. */
  const tick = Effect.gen(function* () {
    yield* finishDeferred;
    yield* resumeLimitedChats;
    for (const goal of yield* store.list) {
      // Landed work's worktrees are removed whatever became of the goal afterwards.
      if (goal.status !== "running" && goal.agentQueue) yield* sweepLandedWorktrees(goal);
      if (goal.status !== "running") continue;
      if (goal.agentQueue) {
        yield* ensureIntegration(goal.id);
        yield* resumeSubmissions(goal);
        yield* settleFinishedChats(goal);
        yield* sweepIdleChats(goal.id);
        yield* sweepLandedWorktrees(goal);
        yield* deliverJobResults(goal.id).pipe(
          lock.withPermits(1),
          Effect.catchCause(logFailure("goals.job-delivery-failed")),
        );
      }
      yield* fillLanes(goal.id).pipe(
        lock.withPermits(1),
        Effect.catchCause(logFailure("goals.tick-failed")),
      );
      if (goal.agentQueue) yield* recoverStall(goal.id);
    }
  });

  /**
   * Wakes the scheduler when the queue changes, from any writer: a merge that unlocks
   * dependants, a conflict that needs a repair worker, a task added or released. The
   * slow tick still reconciles, so a missed event only delays work.
   */
  const pollQueueEvents = Effect.gen(function* () {
    for (const goal of yield* store.list) {
      const binding = goal.agentQueue;
      if (goal.status !== "running" || !binding) continue;
      const batch = yield* queue
        .events(binding, goal.queueEventCursor ?? -1)
        .pipe(Effect.orElseSucceed(() => undefined));
      if (!batch) continue;
      if (batch.last !== goal.queueEventCursor) {
        yield* store.update(goal.id, (current) => ({ ...current, queueEventCursor: batch.last }));
      }
      if (batch.events.length === 0) continue;
      yield* ensureIntegration(goal.id);
      yield* fillLanes(goal.id).pipe(
        lock.withPermits(1),
        Effect.catchCause(logFailure("goals.event-fill-failed")),
      );
    }
  }).pipe(Effect.catchCause(logFailure("goals.queue-events-failed")));

  /**
   * One scheduler loop. While a queue goal runs it looks at the queue's event log every
   * second; the full reconciling tick still runs every TICK_INTERVAL. Without queue goals
   * it is the plain tick it always was.
   */
  const schedulerLoop = Effect.gen(function* () {
    let lastTick = Number.NEGATIVE_INFINITY;
    while (true) {
      const watching = (yield* store.list).some(
        (goal) => goal.status === "running" && goal.agentQueue !== undefined,
      );
      yield* Effect.sleep(watching ? "1 second" : TICK_INTERVAL);
      const watchingNow = (yield* store.list).some(
        (goal) => goal.status === "running" && goal.agentQueue !== undefined,
      );
      // A failed pass is logged and retried. A slow pass keeps ownership of its operations.
      yield* Effect.gen(function* () {
        if (watchingNow) yield* pollQueueEvents;
        const now = yield* nowMillis;
        if (!watchingNow || now - lastTick >= TICK_MILLIS - 500) {
          lastTick = now;
          yield* tick;
        }
      }).pipe(
        // Queue APIs return promises that may still own subprocesses and database writes.
        // Observe a slow pass; never abandon it and begin a competing operation.
        (pass) =>
          Effect.scoped(
            Effect.gen(function* () {
              yield* Effect.forkScoped(
                Effect.sleep(SCHEDULER_PASS_TIMEOUT).pipe(
                  Effect.andThen(
                    Effect.logWarning("goals.scheduler-pass-slow", {
                      after: SCHEDULER_PASS_TIMEOUT,
                    }),
                  ),
                ),
              );
              yield* pass;
            }),
          ),
        Effect.catchCause((cause) =>
          Cause.hasInterruptsOnly(cause)
            ? Effect.interrupt
            : logFailure("goals.scheduler-pass-failed")(cause),
        ),
      );
    }
  });

  const loop = Effect.all(
    [
      recover.pipe(Effect.catchCause(logFailure("goals.recovery-failed"))),
      superviseForever(
        "session-events",
        Stream.runForEach(threads.runChanges, (threadId) =>
          onSessionSet({ threadId }).pipe(
            Effect.catchCause(logFailure("goals.session-event-failed")),
          ),
        ),
      ),
      superviseForever("scheduler", schedulerLoop),
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
    /** The plan an earlier run of this goal was bound to, kept when it is started again. */
    previous?: { readonly planPath: string },
  ) {
    const requested = requestedQueueMode(settings);
    if (requested === "standard") {
      return { ok: true as const, agentQueue: undefined, queueReason: undefined };
    }
    const preview = yield* choose({
      projectId: settings.projectId,
      queueMode: requested,
      planPath: settings.planPath ?? previous?.planPath,
    });
    if (preview.blocked) return { ok: false as const, message: preview.summary };
    // Starting a finished AgentQueue goal again must not turn it into a standard goal just
    // because its plan is complete: it stays bound and finishes by itself.
    const stillBound =
      previous !== undefined && requested === "auto" && preview.readiness === "complete";
    if (preview.effectiveMode === "standard" && !stillBound) {
      return {
        ok: true as const,
        agentQueue: undefined,
        queueReason: requested === "auto" ? preview.summary : undefined,
      };
    }
    const bound = yield* queue.bind(preview.repoRoot, preview.planPath ?? previous?.planPath).pipe(
      Effect.asSome,
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
    // Events from here on wake the scheduler; earlier ones are already reflected in the queue.
    const cursor = yield* queue.events(bound.value as QueueBinding, -1).pipe(
      Effect.map((batch) => batch.last),
      Effect.orElseSucceed(() => undefined),
    );
    return {
      ok: true as const,
      agentQueue: { ...(bound.value as QueueBinding), importedAt },
      queueReason: undefined,
      queueEventCursor: cursor,
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
    const projectFolder = yield* threads.workspaceRoot(settings.projectId);
    if (projectFolder === undefined) {
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
        ...(binding?.queueEventCursor !== undefined
          ? { queueEventCursor: binding.queueEventCursor }
          : {}),
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
      const binding = yield* resolveBinding(goal, goal.agentQueue);
      if (!binding.ok) {
        yield* setStatus(id, "failed", binding.message.slice(0, 1500));
        return;
      }
      yield* store.update(id, (current) => ({
        ...current,
        agentQueue: binding.agentQueue,
        queueReason: binding.queueReason,
        queueErrors: undefined,
        queueEventCursor: binding.queueEventCursor,
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
    listEscalations,
    readEscalation,
    replyEscalation,
    resolveEscalation,
    openEscalation,
    cancelEscalation,
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
    listEscalations: () => Effect.succeed([]),
    readEscalation: () => Effect.die("readEscalation is not available without a server"),
    replyEscalation: () => Effect.die("replyEscalation is not available without a server"),
    resolveEscalation: () => Effect.die("resolveEscalation is not available without a server"),
    openEscalation: () => Effect.die("openEscalation is not available without a server"),
    cancelEscalation: () => Effect.die("cancelEscalation is not available without a server"),
    loop: Effect.void,
  }),
);
