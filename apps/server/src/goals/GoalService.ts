// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off preferSchemaOverJson:off globalConsole:off
import { AgentQueueService, resolveGitContext } from "../queue/AgentQueueService.ts";
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
  const blocked = chats.filter(
    (chat) => chat.status === "failed" || chat.status === "attention",
  ).length;
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
  const queueAssignments = new Map<
    ThreadId,
    {
      readonly gitCommonDir: string;
      readonly repoRoot: string;
      readonly taskId: string;
      readonly claimToken: string;
      readonly worktreePath: string;
      readonly branch: string;
      readonly verificationCommand: string;
      readonly baseBranch: string;
    }
  >();
  /** Serializes everything that changes a goal's chats, so lanes are never over-filled. */
  const lock = yield* Semaphore.make(1);
  const queueServiceOpt = yield* Effect.serviceOption(AgentQueueService);
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

  /** Open a worker chat for the goal on `agentIndex`, titled "Goal worker #N". */
  const startChat = Effect.fn("GoalService.startChat")(function* (goal: Goal, agentIndex: number) {
    const agent = goal.agents[agentIndex];
    if (!agent) return false;

    let worktreePath: string | null = null;
    let branch: string | null = null;
    let taskId: string | undefined = undefined;
    let queueAssignment:
      | {
          readonly gitCommonDir: string;
          readonly repoRoot: string;
          readonly taskId: string;
          readonly claimToken: string;
          readonly worktreePath: string;
          readonly branch: string;
          readonly verificationCommand: string;
          readonly baseBranch: string;
        }
      | undefined;
    let promptText = goalPrompt(goal);
    let chatTitle = goalWorkerTitle(goal.chats.filter((chat) => !chat.overseer).length + 1);

    if ((goal.useAgentQueue || goal.queueMode === "agentqueue") && Option.isSome(queueServiceOpt)) {
      const queueSvc = queueServiceOpt.value;
      const workspaceRoot = (yield* workspaceRootOf(goal.projectId)) ?? "";
      if (!workspaceRoot) return false;
      const { gitCommonDir, baseBranch } = resolveGitContext(workspaceRoot);
      const workerId = `goal-${goal.id}-agent-${agentIndex}-${yield* randomUUID}`;
      const assignment = yield* queueSvc
        .reserveNext(gitCommonDir, workspaceRoot, workerId, baseBranch, goal.planId)
        .pipe(Effect.catchCause(() => Effect.succeed(null)));

      if (!assignment) {
        return false;
      }

      taskId = assignment.taskId;
      worktreePath = assignment.worktreePath;
      branch = assignment.branch;
      queueAssignment = {
        gitCommonDir,
        repoRoot: workspaceRoot,
        taskId: assignment.taskId,
        claimToken: assignment.claimToken,
        worktreePath: assignment.worktreePath,
        branch: assignment.branch,
        verificationCommand: assignment.verificationCommand ?? "",
        baseBranch: assignment.baseBranch,
      };
      chatTitle = `Goal worker (${assignment.taskId}): ${assignment.title}`;
      promptText = [
        `You are an automated coding agent assigned to task **${assignment.taskId}**: "${assignment.title}".`,
        `Your worktree is at: \`${assignment.worktreePath}\``,
        `Your branch is: \`${assignment.branch}\``,
        assignment.prompt ? `\nTask details:\n${assignment.prompt}` : "",
        "",
        "### Instructions:",
        "1. Inspect the task requirements and implement the changes in your isolated worktree.",
        "2. Test and verify your changes thoroughly using project test suites.",
        "3. Commit your changes to your assigned branch with a clear commit message.",
        assignment.verificationCommand
          ? `4. Check that your changes pass: \`${assignment.verificationCommand}\``
          : "4. Verify all tests pass before completing.",
        "5. Report that the task is ready for server verification and merge. Do not mark the queue task complete yourself.",
      ].join("\n");
    }

    const threadId = yield* openChat(goal, {
      title: chatTitle,
      text: promptText,
      agentIndex,
      modelSelection: agent.modelSelection,
      worktreePath,
      branch,
      taskId,
    });
    if (queueAssignment && threadId) queueAssignments.set(threadId, queueAssignment);
    if (queueAssignment && !threadId) {
      const queueSvc = Option.isSome(queueServiceOpt) ? queueServiceOpt.value : undefined;
      if (queueSvc) {
        yield* queueSvc
          .release(
            queueAssignment.gitCommonDir,
            queueAssignment.claimToken,
            "failed",
            "Goal worker did not start",
          )
          .pipe(Effect.catchCause(() => Effect.void));
        yield* queueSvc
          .teardown(
            queueAssignment.repoRoot,
            queueAssignment.worktreePath,
            queueAssignment.branch,
            false,
          )
          .pipe(Effect.catchCause(() => Effect.void));
      }
    }
    return threadId !== null;
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
    yield* updateChat(goal.id, threadId, {
      status: failed ? "failed" : "completed",
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
    });
    if (goal.status !== "running") return;
    const reason = stuckReasons.get(goal.id) ?? "The goal got stuck.";
    stuckReasons.delete(goal.id);
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
    const targets = problemChatsOf(goal);
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
    if (
      (first.useAgentQueue || first.queueMode === "agentqueue") &&
      Option.isSome(queueServiceOpt)
    ) {
      for (const chat of first.chats) {
        if (chat.status !== "running") continue;
        const assignment = queueAssignments.get(chat.threadId);
        if (!assignment) continue;
        const renewed = yield* queueServiceOpt.value
          .heartbeat(assignment.gitCommonDir, assignment.claimToken)
          .pipe(Effect.catchCause(() => Effect.succeed(false)));
        if (!renewed) {
          yield* Effect.logWarning("goals.agentqueue-lease-lost", {
            goalId,
            taskId: assignment.taskId,
            threadId: chat.threadId,
          });
        }
      }
    }
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
      if (!(yield* startChat(goal, agentIndex))) break;
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

    if (goal.useAgentQueue || goal.queueMode === "agentqueue") {
      if (Option.isSome(queueServiceOpt)) {
        const queueSvc = queueServiceOpt.value;
        const workspaceRoot = (yield* workspaceRootOf(goal.projectId)) ?? "";
        const { gitCommonDir } = resolveGitContext(workspaceRoot);
        const snapshot = yield* queueSvc
          .getSnapshot(gitCommonDir, goal.planId)
          .pipe(Effect.catchCause(() => Effect.succeed(undefined)));

        if (
          snapshot &&
          snapshot.counts.total > 0 &&
          snapshot.counts.completed === snapshot.counts.total
        ) {
          yield* setStatus(goalId, "complete", "All tasks in queue completed and verified.");
          return;
        }
      }
    }

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
    const queueMode = before.useAgentQueue || before.queueMode === "agentqueue";
    const queueAssignment = queueAssignments.get(threadId);
    let queueTaskIntegrated = false;
    if (queueMode && chat.taskId) {
      if (status === "completed" && queueAssignment && Option.isSome(queueServiceOpt)) {
        const result = queueAssignment.verificationCommand.trim()
          ? yield* queueServiceOpt.value
              .verifyAndLand(
                queueAssignment.gitCommonDir,
                queueAssignment.repoRoot,
                queueAssignment.taskId,
                queueAssignment.claimToken,
                queueAssignment.worktreePath,
                queueAssignment.branch,
                queueAssignment.baseBranch,
                queueAssignment.verificationCommand,
              )
              .pipe(
                Effect.catchCause((cause) =>
                  Effect.succeed({ success: false as const, error: String(cause) }),
                ),
              )
          : { success: false as const, error: "No verification command is configured" };
        queueTaskIntegrated = result.success;
        if (queueTaskIntegrated) {
          yield* queueServiceOpt.value
            .release(queueAssignment.gitCommonDir, queueAssignment.claimToken, "completed")
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
          yield* queueServiceOpt.value
            .teardown(
              queueAssignment.repoRoot,
              queueAssignment.worktreePath,
              queueAssignment.branch,
              true,
            )
            .pipe(Effect.catchCause(logFailure("goals.agentqueue-worktree-cleanup-failed")));
        } else {
          status = "failed";
        }
      } else if (status === "completed") {
        // After a server restart, a completed chat may outlive its in-memory claim token.
        // Leave the queue task for lease recovery instead of claiming it was integrated.
        status = "failed";
      }

      if (!queueTaskIntegrated && queueAssignment && Option.isSome(queueServiceOpt)) {
        const finalQueueStatus = status === "stopped" ? "pending" : "failed";
        yield* queueServiceOpt.value
          .release(
            queueAssignment.gitCommonDir,
            queueAssignment.claimToken,
            finalQueueStatus,
            status === "stopped" ? undefined : "Goal worker did not verify and land the task",
          )
          .pipe(Effect.catchCause(() => Effect.void));
        yield* queueServiceOpt.value
          .teardown(
            queueAssignment.repoRoot,
            queueAssignment.worktreePath,
            queueAssignment.branch,
            false,
          )
          .pipe(Effect.catchCause(logFailure("goals.agentqueue-worktree-preserve-failed")));
      }
      queueAssignments.delete(threadId);
    }

    yield* updateChat(goalId, threadId, {
      status,
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
      ...(blockedWork ? { blockedWork: true } : {}),
    });

    if (before.status !== "running") return;

    if (!queueMode && status === "completed" && !blockedWork && replyReportsGoalComplete(reply)) {
      yield* setStatus(goalId, "complete", "An agent reported there is nothing left to do.");
      return;
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
          yield* updateChat(goal.id, chat.threadId, {
            status: "failed",
            completedAt: yield* nowIso,
          });
        } else {
          watching.set(chat.threadId, { goalId: goal.id, seenRunning: true });
        }
      }
      if (goal.status === "running") yield* fillLanes(goal.id);
    }
  }).pipe(lock.withPermits(1));

  /** Running goals look for room to start the next plan worker. */
  const tick = Effect.gen(function* () {
    for (const goal of yield* store.list) {
      if (goal.status !== "running") continue;
      yield* fillLanes(goal.id).pipe(
        lock.withPermits(1),
        Effect.catchCause(logFailure("goals.tick-failed")),
      );
    }
  });

  const loop = Effect.all(
    [
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
      const goal: Goal = {
        ...settings,
        id: GoalId.make(yield* randomUUID),
        status: draft ? "draft" : "running",
        createdAt: now,
        updatedAt: now,
        chats: [],
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
