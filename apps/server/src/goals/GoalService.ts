/**
 * Runs goals: keeps `lanes` chats working at once, starts the next as each
 * finishes, and stops when an agent says nothing is left.
 *
 * A goal starts from an ordinary chat message beginning `!goal`. The chat the
 * person typed in becomes the first lane; the others are new ordinary threads
 * in the same project. Nothing here is a parallel code path: every chat is a
 * `thread.create` plus `thread.turn.start`, the same commands a person's
 * message produces, so provider routing, history and approvals all behave
 * normally.
 *
 * Three rules keep unattended work from running away:
 *  - A chat that fails does not restart its lane, so a broken setup cannot
 *    loop through the whole chat budget.
 *  - A chat stopped by a provider usage limit waits for the limit to reset
 *    (Auto-resume or the person resumes it) instead of counting as a failure.
 *  - A goal never starts more than `maxChats` chats per start.
 *
 * @module goals/GoalService
 */
import {
  CommandId,
  MessageId,
  OrchestrationDispatchCommandError,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationThread,
  type ProjectId,
} from "@t3tools/contracts";
import {
  DEFAULT_GOAL_LANES,
  DEFAULT_GOAL_MAX_CHATS,
  GOAL_COMMAND,
  type Goal,
  type GoalChat,
  GoalId,
  goalPrompt,
  isGoalCommand,
  parseGoalCommand,
  replyReportsGoalComplete,
} from "@t3tools/contracts/goals";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
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
import * as ServerSettings from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import { GoalStore } from "./GoalStore.ts";

const TITLE_TIMEOUT = "30 seconds";
const PROVISIONAL_TITLE_LENGTH = 60;

export class GoalService extends Context.Service<
  GoalService,
  {
    /**
     * Start a goal when the message begins `!goal`, and return the command to
     * dispatch: the same command with the goal's prompt as its message. Any
     * other command comes back untouched.
     */
    readonly interceptTurnStart: (
      command: ClientOrchestrationCommand,
    ) => Effect.Effect<ClientOrchestrationCommand, OrchestrationDispatchCommandError>;
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

/** How many more chats this goal may start right now. */
export function chatsToStart(goal: Goal): number {
  if (goal.status !== "running") return 0;
  const chats = chatsSinceStart(goal);
  const running = chats.filter((chat) => chat.status === "running").length;
  // A failed chat keeps its lane closed for the rest of this start.
  const failed = chats.filter((chat) => chat.status === "failed").length;
  return Math.max(0, Math.min(goal.lanes - running - failed, goal.maxChats - chats.length));
}

const lastAssistantReply = (thread: OrchestrationThread | undefined) =>
  thread?.messages.findLast((message) => message.role === "assistant")?.text;

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery;
  const store = yield* GoalStore;
  const textGeneration = yield* TextGeneration;
  const settingsService = yield* ServerSettings.ServerSettingsService;
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

  const addChat = (goal: Goal, chat: GoalChat) =>
    store.update(goal.id, (current) => ({
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
          : { completedAt: now, ...(detail ? { detail } : { detail: undefined }) }),
      }));
    });

  /** Open one new chat for the goal. Returns whether it started. */
  const startChat = Effect.fn("GoalService.startChat")(function* (goal: Goal) {
    const threadId = ThreadId.make(yield* randomUUID);
    const createdAt = yield* nowIso;
    const number = goal.chats.length + 1;
    const modelSelection = goal.modelSelection;
    const created = yield* engine
      .dispatch({
        type: "thread.create",
        commandId: CommandId.make(`goal-create:${yield* randomUUID}`),
        threadId,
        projectId: goal.projectId,
        title: `${goal.title} · ${number}`,
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
    yield* addChat(goal, { threadId, status: "running", startedAt: createdAt });
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
        titleSeed: goal.title,
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

  /** Start chats until the lanes are full, the budget is spent, or a start fails. */
  const fillLanes = Effect.fn("GoalService.fillLanes")(function* (goalId: GoalId) {
    while (true) {
      const goal = (yield* store.list).find((candidate) => candidate.id === goalId);
      if (!goal || chatsToStart(goal) === 0) break;
      if (!(yield* startChat(goal))) break;
    }
    yield* settleIfIdle(goalId);
  });

  /** A running goal with nothing running and nothing left to start is over. */
  const settleIfIdle = Effect.fn("GoalService.settleIfIdle")(function* (goalId: GoalId) {
    const goal = (yield* store.list).find((candidate) => candidate.id === goalId);
    if (!goal || goal.status !== "running") return;
    const chats = chatsSinceStart(goal);
    if (chats.some((chat) => chat.status === "running") || chatsToStart(goal) > 0) return;
    const failed = chats.filter((chat) => chat.status === "failed").length;
    yield* setStatus(
      goalId,
      "failed",
      failed >= goal.lanes
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
    const completedAt = yield* nowIso;
    const goal = yield* updateChat(goalId, threadId, {
      status: failed ? "failed" : "completed",
      completedAt,
      waitingForLimit: undefined,
    });
    if (!goal) return;
    const chat = goal.chats.find((candidate) => candidate.threadId === threadId);
    // The chat the person typed in is theirs to keep; the others tidy themselves away.
    if (!chat?.origin) {
      yield* engine
        .dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`goal-archive:${yield* randomUUID}`),
          threadId,
        })
        .pipe(Effect.ignoreCause({ log: true }));
    }
    if (goal.status !== "running") return;
    if (!failed && replyReportsGoalComplete(lastAssistantReply(thread))) {
      yield* setStatus(goalId, "complete", "An agent reported there is nothing left to do.");
      return;
    }
    yield* fillLanes(goalId);
  });

  const onSessionSet = (event: {
    readonly threadId: ThreadId;
    readonly session: {
      readonly activeTurnId: unknown;
      readonly status: string;
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
        yield* updateChat(watch.goalId, event.threadId, { waitingForLimit: true });
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
          const limited = thread.session?.lastErrorClass === "usage_limit";
          if (limited) {
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

  /** Replace the provisional title with one written by the text-generation model. */
  const generateTitle = Effect.fn("GoalService.generateTitle")(function* (goal: Goal, cwd: string) {
    const settings = yield* settingsService.getSettings;
    const { textGenerationModelSelection: modelSelection } = resolveProjectSettings(
      settings,
      goal.projectId,
    ).settings;
    const generated = yield* textGeneration
      .generateThreadTitle({ cwd, message: goal.prompt, modelSelection })
      .pipe(Effect.timeout(TITLE_TIMEOUT));
    const title = generated.title.trim();
    if (title.length === 0) return;
    yield* store.update(goal.id, (current) => ({ ...current, title }));
  });

  const interceptTurnStart: GoalService["Service"]["interceptTurnStart"] = Effect.fn(
    "GoalService.interceptTurnStart",
  )(function* (command) {
    if (command.type !== "thread.turn.start" || !isGoalCommand(command.message.text)) {
      return command;
    }
    const parsed = parseGoalCommand(command.message.text);
    if (!parsed) {
      return yield* new OrchestrationDispatchCommandError({
        message: `Say what the goal is after ${GOAL_COMMAND}, for example: ${GOAL_COMMAND} finish everything in PLAN.md`,
      });
    }
    const createThread = command.bootstrap?.createThread;
    const existing = createThread
      ? Option.none()
      : yield* snapshots
          .getThreadShellById(command.threadId)
          .pipe(
            Effect.mapError(
              (cause) => new OrchestrationDispatchCommandError({ message: cause.message }),
            ),
          );
    const projectId: ProjectId | undefined =
      createThread?.projectId ?? Option.getOrUndefined(existing)?.projectId;
    const modelSelection =
      command.modelSelection ??
      createThread?.modelSelection ??
      Option.getOrUndefined(existing)?.modelSelection;
    if (!projectId || !modelSelection) {
      return yield* new OrchestrationDispatchCommandError({
        message: "A goal needs a chat in a project, so it knows where to work.",
      });
    }
    const project = yield* snapshots.getProjectShells([projectId]).pipe(
      Effect.map((projects) => projects[0]),
      Effect.mapError((cause) => new OrchestrationDispatchCommandError({ message: cause.message })),
    );
    const now = yield* nowIso;
    const goal: Goal = {
      id: GoalId.make(yield* randomUUID),
      // Replaced by the model's title shortly; this keeps the list readable meanwhile.
      title: parsed.description.slice(0, PROVISIONAL_TITLE_LENGTH),
      description: parsed.description,
      prompt: parsed.prompt,
      projectId,
      modelSelection,
      runtimeMode: command.runtimeMode,
      lanes: parsed.lanes ?? DEFAULT_GOAL_LANES,
      maxChats: DEFAULT_GOAL_MAX_CHATS,
      status: "running",
      createdAt: now,
      updatedAt: now,
      chats: [{ threadId: command.threadId, status: "running", startedAt: now, origin: true }],
    };
    yield* store.add(goal);
    watching.set(command.threadId, { goalId: goal.id, seenRunning: false });
    yield* Effect.forkDetach(
      Effect.gen(function* () {
        yield* lock.withPermits(1)(fillLanes(goal.id));
        if (project) yield* generateTitle(goal, project.workspaceRoot);
      }).pipe(Effect.catchCause(logFailure("goals.start-failed"))),
    );
    return {
      ...command,
      message: { ...command.message, text: goalPrompt(goal) },
      titleSeed: parsed.description,
    };
  });

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

  return GoalService.of({
    interceptTurnStart,
    list: store.list,
    stop,
    restart,
    remove,
    loop,
  });
});

export const layer = Layer.effect(GoalService, make);

/** Service that starts nothing and passes every command through, for contexts with no goals. */
export const layerTest = Layer.succeed(
  GoalService,
  GoalService.of({
    interceptTurnStart: (command) => Effect.succeed(command),
    list: Effect.succeed([]),
    stop: () => Effect.succeed([]),
    restart: () => Effect.succeed([]),
    remove: () => Effect.succeed([]),
    loop: Effect.void,
  }),
);
