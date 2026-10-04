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
 *  - Only a chat that finished its work successfully is archived. One that
 *    failed, was stopped, or needs the person stays in the thread list.
 *  - A chat stopped by a provider usage limit is not a failure. With auto
 *    resume on, it is scheduled to continue when the limit resets and the goal
 *    waits for it.
 *  - A goal never starts more chats than its cap, per start.
 *  - Chats start at most one every START_SPACING, so providers get breathing room.
 *  - A goal stops starting chats once `stopAfterProblems` finished chats in a
 *    row failed, needed the person, or found only blocked work, so a plan that
 *    cannot be finished does not spend usage all night.
 *  - Stopping a goal never interrupts chats already working; they finish and
 *    are recorded like any other.
 *  - With Beads, a chat starts only when a chunk is ready and is handed that
 *    chunk; with nothing ready the goal waits for working chats to unblock more.
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
import {
  type Goal,
  type GoalChat,
  GoalId,
  type GoalSettings,
  goalPrompt,
  goalSettingsProblem,
  DEFAULT_GOAL_STOP_AFTER_PROBLEMS,
  goalTitle,
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
import { nextUsageLimitRetryAt } from "../provider/usageLimits.ts";
import { type Bead, type BeadsSnapshot, GoalBeads } from "./GoalBeads.ts";
import { GoalStore } from "./GoalStore.ts";

/** Time between one chat starting and the next, per goal. Zero in tests. */
export const StartSpacingMillis = Context.Reference<number>("t3/goals/StartSpacingMillis", {
  defaultValue: () => 15_000,
});

/** How often running goals look for room to start another chat. */
const TICK_INTERVAL = "5 seconds";
/** A Beads answer this fresh is reused, so ticks do not run `bd` every few seconds. */
const BEADS_FRESH_MILLIS = 10_000;

export class GoalService extends Context.Service<
  GoalService,
  {
    /** Create a goal and start its first chats. */
    readonly create: (
      settings: GoalSettings,
    ) => Effect.Effect<ReadonlyArray<Goal>, OrchestrationDispatchCommandError>;
    readonly list: Effect.Effect<ReadonlyArray<Goal>>;
    /** Change any setting. Chats already working keep the instructions they started with. */
    readonly update: (
      id: GoalId,
      settings: GoalSettings,
    ) => Effect.Effect<ReadonlyArray<Goal>, OrchestrationDispatchCommandError>;
    /** Stop starting chats. Chats already working are left to finish. */
    readonly stop: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    readonly restart: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    readonly remove: (id: GoalId) => Effect.Effect<ReadonlyArray<Goal>>;
    /** Recovers goals after a restart, then reacts to chats finishing. Fork it. */
    readonly loop: Effect.Effect<void>;
  }
>()("t3/goals/GoalService") {}

/** Chats that count against this start: a restart gets a fresh budget. */
export function chatsSinceStart(goal: Goal): ReadonlyArray<GoalChat> {
  const since = Date.parse(goal.restartedAt ?? goal.createdAt);
  return goal.chats.filter((chat) => Date.parse(chat.startedAt) >= since);
}

/**
 * Which agent the next chat should use, or undefined when none has room. The
 * agent furthest below its own count goes first, so counts fill evenly.
 */
export function nextAgentIndex(goal: Goal): number | undefined {
  if (goal.status !== "running" || goal.holdStarts) return undefined;
  const chats = chatsSinceStart(goal);
  const running = chats.filter((chat) => chat.status === "running");
  const blocked = chats.filter(
    (chat) => chat.status === "failed" || chat.status === "attention",
  ).length;
  // A failed chat, or one waiting for the person, keeps its lane closed for the rest of this start.
  if (running.length + blocked >= goal.concurrency) return undefined;
  if (goal.maxChats !== null && chats.length >= goal.maxChats) return undefined;
  let best: { index: number; load: number } | undefined;
  goal.agents.forEach((agent, index) => {
    const active = running.filter((chat) => chat.agentIndex === index).length;
    if (active >= agent.count) return;
    const load = active / agent.count;
    if (!best || load < best.load) best = { index, load };
  });
  return best?.index;
}

const lastAssistantReply = (thread: OrchestrationThread | undefined) =>
  thread?.messages.findLast((message) => message.role === "assistant")?.text;

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
  const beads = yield* GoalBeads;
  const spacing = yield* StartSpacingMillis;
  const nowMillis = Effect.map(DateTime.now, DateTime.toEpochMillis);
  /** When each goal last started a chat, for spacing starts apart. */
  const lastStart = new Map<GoalId, number>();
  /** The latest Beads answer per goal, and when it was read. */
  const beadsCache = new Map<GoalId, { readonly at: number; readonly snapshot: BeadsSnapshot }>();

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
   * The goal's Beads queue, reused for a few seconds unless `fresh`. Undefined
   * when Beads cannot be read right now; the goal then waits for the next tick.
   */
  const queueOf = Effect.fn("GoalService.queueOf")(function* (goal: Goal, fresh: boolean) {
    const now = yield* nowMillis;
    const checkedAt = yield* nowIso;
    const cached = beadsCache.get(goal.id);
    if (!fresh && cached && now - cached.at < BEADS_FRESH_MILLIS) return cached.snapshot;
    const root = yield* workspaceRootOf(goal.projectId);
    if (!root) return undefined;
    const snapshot = yield* beads
      .snapshot(root, goal.beadsScope)
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("goals.beads-unreadable", { cause: error.message }).pipe(
            Effect.as(undefined),
          ),
        ),
      );
    if (!snapshot) return undefined;
    beadsCache.set(goal.id, { at: now, snapshot });
    const queue = goal.queue;
    if (
      !queue ||
      queue.ready !== snapshot.ready.length ||
      queue.working !== snapshot.working ||
      queue.blocked !== snapshot.blocked ||
      queue.done !== snapshot.done
    ) {
      yield* store.update(goal.id, (current) => ({
        ...current,
        queue: {
          ready: snapshot.ready.length,
          working: snapshot.working,
          blocked: snapshot.blocked,
          done: snapshot.done,
          checkedAt,
        },
      }));
    }
    return snapshot;
  });

  /** Beads only counts when the project has it; otherwise the goal runs plain agents. */
  const usesBeads = (settings: GoalSettings, workspaceRoot: string) =>
    settings.useBeads === true ? beads.available(workspaceRoot) : Effect.succeed(false);

  /** Open one new chat for the goal on `agentIndex`. Returns whether it started. */
  const startChat = Effect.fn("GoalService.startChat")(function* (
    goal: Goal,
    agentIndex: number,
    bead?: Bead,
  ) {
    const agent = goal.agents[agentIndex];
    if (!agent) return false;
    const threadId = ThreadId.make(yield* randomUUID);
    const createdAt = yield* nowIso;
    const modelSelection = agent.modelSelection;
    const created = yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`goal-create:${yield* randomUUID}`),
        threadId,
        projectId: goal.projectId,
        title: `${goalTitle(goal)} · ${bead ? bead.id : goal.chats.length + 1}`,
        modelSelection,
        runtimeMode: goal.runtimeMode,
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdAt,
      })
      .pipe(
        Effect.as(true),
        Effect.catchCause((cause) =>
          logFailure("goals.chat-create-failed")(cause).pipe(Effect.as(false)),
        ),
      );
    if (!created) return false;
    // Registered before the turn starts so a fast provider cannot finish unseen.
    watching.set(threadId, { goalId: goal.id, seenRunning: false });
    yield* addChat(goal.id, {
      threadId,
      agentIndex,
      status: "running",
      startedAt: createdAt,
      ...(bead ? { beadId: bead.id, beadTitle: bead.title } : {}),
    });
    const started = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`goal-turn:${yield* randomUUID}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text: goalPrompt(goal, bead),
          attachments: [],
        },
        modelSelection,
        titleSeed: goalTitle(goal),
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
      yield* updateChat(goal.id, threadId, { status: "failed", completedAt: yield* nowIso });
      yield* engine
        .dispatch({
          type: "thread.delete",
          commandId: CommandId.make(`goal-cleanup:${yield* randomUUID}`),
          threadId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    return started;
  });

  /**
   * Start chats until the lanes are full, the cap is reached, or a start fails;
   * at most one per START_SPACING. With Beads, only as many as there are ready
   * chunks that no working chat already holds.
   */
  const fillLanes = Effect.fn("GoalService.fillLanes")(function* (goalId: GoalId) {
    const first = yield* currentGoal(goalId);
    if (!first || first.status !== "running") return;
    let candidates: Array<Bead> | undefined;
    if (first.useBeads) {
      const queue = yield* queueOf(first, false);
      // Unreadable right now: do not guess, try again on the next tick.
      if (!queue) return;
      const held = new Set(
        first.chats
          .filter((chat) => chat.status === "running" || chat.status === "attention")
          .flatMap((chat) => (chat.beadId ? [chat.beadId] : [])),
      );
      candidates = queue.ready.filter((bead) => !held.has(bead.id));
    }
    while (true) {
      const goal = yield* currentGoal(goalId);
      const agentIndex = goal ? nextAgentIndex(goal) : undefined;
      if (!goal || agentIndex === undefined) break;
      const now = yield* nowMillis;
      const last = lastStart.get(goalId);
      if (spacing > 0 && last !== undefined && now - last < spacing) break;
      const bead = candidates?.shift();
      if (candidates && !bead) break;
      if (!(yield* startChat(goal, agentIndex, bead))) break;
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
    const next = nextAgentIndex(goal);
    if (goal.useBeads) {
      const queue = beadsCache.get(goalId)?.snapshot;
      if (!queue) return;
      if (queue.ready.length + queue.working + queue.blocked === 0) {
        yield* setStatus(goalId, "complete", "Beads has no unfinished work left.");
        return;
      }
      if (next !== undefined && queue.ready.length > 0) return;
      if (queue.ready.length === 0) {
        const holding = chats.filter((chat) => chat.status === "attention").length;
        // Chunks claimed by someone else may still finish and unblock more.
        if (queue.working > holding) return;
        yield* setStatus(
          goalId,
          "failed",
          holding > 0
            ? `Waiting on you: ${holding} agent${holding === 1 ? "" : "s"} need${holding === 1 ? "s" : ""} attention, and the other ${queue.blocked} unfinished chunks are blocked behind ${holding === 1 ? "it" : "them"}.`
            : `Stalled: ${queue.blocked} unfinished chunks are blocked and none is ready or being worked on. Check their dependencies.`,
        );
        return;
      }
    } else if (next !== undefined) {
      return;
    }
    const blocked = chats.filter(
      (chat) => chat.status === "failed" || chat.status === "attention",
    ).length;
    yield* setStatus(
      goalId,
      "failed",
      goal.holdStarts
        ? "Stalled: the remaining tasks are blocked and no agent is working to unblock them."
        : blocked >= goal.concurrency
          ? "Every chat failed or needs you, so the goal stopped. Open them to see why."
          : `Reached the limit of ${goal.maxChats} chats without a GOAL COMPLETE.`,
    );
  });

  /** A goal chat's turn is over for good: record it and decide what happens next. */
  const finishChat = Effect.fn("GoalService.finishChat")(function* (
    goalId: GoalId,
    threadId: ThreadId,
  ) {
    watching.delete(threadId);
    const thread = yield* readThread(threadId);
    const before = yield* currentGoal(goalId);
    const chat = before?.chats.find((candidate) => candidate.threadId === threadId);
    if (!before || !chat) return;
    const root = chat.beadId ? yield* workspaceRootOf(before.projectId) : undefined;
    const failed = thread?.latestTurn?.state !== "completed";
    const reply = lastAssistantReply(thread);
    const needsAttention = !failed && replyNeedsAttention(reply);
    const blockedWork = !failed && !needsAttention && replyReportsBlockedWork(reply);
    let status: GoalChat["status"] = failed ? "failed" : needsAttention ? "attention" : "completed";
    if (chat.beadId && root) {
      if (failed) {
        yield* beads.release(root, chat.beadId);
      } else if (status === "completed" && !blockedWork) {
        // Finished work leaves its chunk closed; anything else is for the person to look at.
        const chunk = yield* beads.statusOf(root, chat.beadId);
        if (chunk !== undefined && chunk !== "closed") status = "attention";
      }
    }
    beadsCache.delete(goalId);
    yield* updateChat(goalId, threadId, {
      status,
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
      ...(blockedWork ? { blockedWork: true } : {}),
    });
    // Only successful work tidies itself out of the thread list (the Goals page still links it).
    // A chat with a problem or a question stays visible until the person has seen it.
    if (status === "completed") {
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`goal-archive:${yield* randomUUID}`),
          threadId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    if (before.status !== "running") return;
    // Real progress frees blocked work to start again; a blocked chat means wait for the others.
    if (status === "completed" && !blockedWork && before.holdStarts) {
      yield* store.update(goalId, (goal) => ({ ...goal, holdStarts: undefined }));
    } else if (blockedWork && !before.useBeads) {
      yield* store.update(goalId, (goal) => ({ ...goal, holdStarts: true }));
    }
    if (
      status === "completed" &&
      !blockedWork &&
      !before.useBeads &&
      replyReportsGoalComplete(reply)
    ) {
      yield* setStatus(goalId, "complete", "An agent reported there is nothing left to do.");
      return;
    }
    const after = yield* currentGoal(goalId);
    const limit = before.stopAfterProblems ?? DEFAULT_GOAL_STOP_AFTER_PROBLEMS;
    if (after && problemStreak(chatsSinceStart(after)) >= limit) {
      yield* setStatus(
        goalId,
        "failed",
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
        const goal = yield* updateChat(watch.goalId, event.threadId, { waitingForLimit: true });
        if (goal?.autoResume) {
          yield* scheduleResume(event.threadId, session).pipe(
            Effect.catchCause(logFailure("goals.resume-schedule-failed")),
          );
        }
        return;
      }
      // A quiet session before the turn ever ran is a leftover from before it.
      if (!watch.seenRunning && session.status !== "error") return;
      yield* finishChat(watch.goalId, event.threadId);
    }).pipe(lock.withPermits(1));

  const recover = Effect.gen(function* () {
    for (const goal of yield* store.list) {
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

  /** Running goals look for room to start the next chat, and for chunks Beads has freed. */
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
  const checkSettings = Effect.fn("GoalService.checkSettings")(function* (settings: GoalSettings) {
    const problem = goalSettingsProblem(settings);
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
    return {
      ...settings,
      useBeads: yield* usesBeads(settings, project.workspaceRoot),
    };
  });

  const create: GoalService["Service"]["create"] = Effect.fn("GoalService.create")(
    function* (input) {
      const settings = yield* checkSettings(input);
      const now = yield* nowIso;
      const goal: Goal = {
        ...settings,
        id: GoalId.make(yield* randomUUID),
        status: "running",
        createdAt: now,
        updatedAt: now,
        chats: [],
      };
      yield* store.add(goal);
      yield* lock.withPermits(1)(fillLanes(goal.id));
      return yield* store.list;
    },
  );

  const update: GoalService["Service"]["update"] = Effect.fn("GoalService.update")(
    function* (id, input) {
      const settings = yield* checkSettings(input);
      yield* lock.withPermits(1)(
        Effect.gen(function* () {
          const now = yield* nowIso;
          const changed = yield* store.update(id, (goal) => ({
            ...goal,
            ...settings,
            updatedAt: now,
          }));
          beadsCache.delete(id);
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

  const restart = Effect.fn("GoalService.restart")(function* (id: GoalId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = yield* currentGoal(id);
        if (!goal || goal.status === "running") return;
        yield* setStatus(id, "running");
        yield* store.update(id, (current) => ({ ...current, holdStarts: undefined }));
        yield* fillLanes(id);
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
        beadsCache.delete(id);
        yield* store.remove(id);
      }),
    );
    return yield* store.list;
  });

  return GoalService.of({ create, update, list: store.list, stop, restart, remove, loop });
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
    remove: () => Effect.succeed([]),
    loop: Effect.void,
  }),
);
