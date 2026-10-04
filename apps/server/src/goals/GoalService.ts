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
 *  - A chat that fails does not restart its lane, so a broken setup cannot
 *    loop through the chat budget (or forever, when there is no cap).
 *  - A chat stopped by a provider usage limit is not a failure. With auto
 *    resume on, it is scheduled to continue when the limit resets and the goal
 *    waits for it.
 *  - A goal never starts more chats than its cap, per start.
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
  goalTitle,
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
import { GoalStore } from "./GoalStore.ts";

export class GoalService extends Context.Service<
  GoalService,
  {
    /** Create a goal and start its first chats. */
    readonly create: (
      settings: GoalSettings,
    ) => Effect.Effect<ReadonlyArray<Goal>, OrchestrationDispatchCommandError>;
    readonly list: Effect.Effect<ReadonlyArray<Goal>>;
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
  if (goal.status !== "running") return undefined;
  const chats = chatsSinceStart(goal);
  const running = chats.filter((chat) => chat.status === "running");
  const failed = chats.filter((chat) => chat.status === "failed").length;
  // A failed chat keeps its lane closed for the rest of this start.
  if (running.length + failed >= goal.concurrency) return undefined;
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

  /** Open one new chat for the goal on `agentIndex`. Returns whether it started. */
  const startChat = Effect.fn("GoalService.startChat")(function* (goal: Goal, agentIndex: number) {
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
        title: `${goalTitle(goal)} · ${goal.chats.length + 1}`,
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
    yield* addChat(goal.id, { threadId, agentIndex, status: "running", startedAt: createdAt });
    const started = yield* engine
      .dispatch({
        type: "thread.turn.start",
        commandId: CommandId.make(`goal-turn:${yield* randomUUID}`),
        threadId,
        message: {
          messageId: MessageId.make(yield* randomUUID),
          role: "user",
          text: goalPrompt(goal),
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

  /** Start chats until the lanes are full, the cap is reached, or a start fails. */
  const fillLanes = Effect.fn("GoalService.fillLanes")(function* (goalId: GoalId) {
    while (true) {
      const goal = (yield* store.list).find((candidate) => candidate.id === goalId);
      const agentIndex = goal ? nextAgentIndex(goal) : undefined;
      if (!goal || agentIndex === undefined) break;
      if (!(yield* startChat(goal, agentIndex))) break;
    }
    yield* settleIfIdle(goalId);
  });

  /** A running goal with nothing running and nothing left to start is over. */
  const settleIfIdle = Effect.fn("GoalService.settleIfIdle")(function* (goalId: GoalId) {
    const goal = (yield* store.list).find((candidate) => candidate.id === goalId);
    if (!goal || goal.status !== "running") return;
    const chats = chatsSinceStart(goal);
    if (chats.some((chat) => chat.status === "running") || nextAgentIndex(goal) !== undefined) {
      return;
    }
    const failed = chats.filter((chat) => chat.status === "failed").length;
    yield* setStatus(
      goalId,
      "failed",
      failed >= goal.concurrency
        ? "Every chat failed, so the goal stopped. Open a failed chat to see why."
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
    const failed = thread?.latestTurn?.state !== "completed";
    const goal = yield* updateChat(goalId, threadId, {
      status: failed ? "failed" : "completed",
      completedAt: yield* nowIso,
      waitingForLimit: undefined,
    });
    if (!goal) return;
    // Finished chats tidy themselves out of the thread list; the Goals page still links them.
    yield* engine
      .dispatch({
        type: "thread.archive",
        commandId: CommandId.make(`goal-archive:${yield* randomUUID}`),
        threadId,
      })
      .pipe(Effect.ignoreCause({ log: true }));
    if (goal.status !== "running") return;
    if (!failed && replyReportsGoalComplete(lastAssistantReply(thread))) {
      yield* setStatus(goalId, "complete", "An agent reported there is nothing left to do.");
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
        if (goal?.autoResume && goal.status === "running") {
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
      if (goal.status !== "running") continue;
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
      yield* fillLanes(goal.id);
    }
  }).pipe(lock.withPermits(1));

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
    ],
    { concurrency: "unbounded", discard: true },
  );

  const create: GoalService["Service"]["create"] = Effect.fn("GoalService.create")(
    function* (settings) {
      const problem = goalSettingsProblem(settings);
      if (problem) return yield* new OrchestrationDispatchCommandError({ message: problem });
      const projects = yield* snapshots
        .getProjectShells([settings.projectId])
        .pipe(
          Effect.mapError(
            (cause) => new OrchestrationDispatchCommandError({ message: cause.message }),
          ),
        );
      if (projects.length === 0) {
        return yield* new OrchestrationDispatchCommandError({
          message: "That project no longer exists.",
        });
      }
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

  const stop = Effect.fn("GoalService.stop")(function* (id: GoalId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = (yield* store.list).find((candidate) => candidate.id === id);
        if (!goal || goal.status !== "running") return;
        yield* setStatus(id, "stopped", "Stopped by you.");
        // Ending the goal ends its running turns; they finish as stopped chats.
        yield* Effect.forEach(
          goal.chats.filter((chat) => chat.status === "running"),
          (chat) =>
            Effect.gen(function* () {
              yield* engine.dispatch({
                type: "thread.turn.interrupt",
                commandId: CommandId.make(`goal-interrupt:${yield* randomUUID}`),
                threadId: chat.threadId,
                createdAt: yield* nowIso,
              });
            }).pipe(Effect.ignoreCause({ log: true })),
          { discard: true },
        );
      }),
    );
    return yield* store.list;
  });

  const restart = Effect.fn("GoalService.restart")(function* (id: GoalId) {
    yield* lock.withPermits(1)(
      Effect.gen(function* () {
        const goal = (yield* store.list).find((candidate) => candidate.id === id);
        if (!goal || goal.status === "running") return;
        yield* setStatus(id, "running");
        yield* fillLanes(id);
      }),
    );
    return yield* store.list;
  });

  const remove = Effect.fn("GoalService.remove")(function* (id: GoalId) {
    yield* stop(id);
    yield* store.remove(id);
    return yield* store.list;
  });

  return GoalService.of({ create, list: store.list, stop, restart, remove, loop });
});

export const layer = Layer.effect(GoalService, make);

/** Service that starts nothing, for contexts with no goals. */
export const layerTest = Layer.succeed(
  GoalService,
  GoalService.of({
    create: () => Effect.succeed([]),
    list: Effect.succeed([]),
    stop: () => Effect.succeed([]),
    restart: () => Effect.succeed([]),
    remove: () => Effect.succeed([]),
    loop: Effect.void,
  }),
);
