// @effect-diagnostics effectFnOpportunity:off - fork service predating the rule; convert to Effect.fn as it is touched.
import {
  CommandId,
  MessageId,
  type ModelSelection,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type ProjectId,
  type RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as OrchestratorV2 from "../orchestration-v2/Orchestrator.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ThreadLaunch from "../orchestration-v2/ThreadLaunchService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";

/** How a worker thread is doing, in the terms the goal runner decides with. */
export interface GoalThreadView {
  readonly messages: ReadonlyArray<{
    readonly id?: string;
    readonly role: "user" | "assistant" | "system";
    readonly text: string;
  }>;
  /** The worker said or did something: nothing is lost by dropping a thread where this is false. */
  readonly madeProgress: boolean;
  readonly session: {
    readonly status: string;
    /** Set while a model turn is running or about to. */
    readonly activeTurnId: string | null;
    readonly lastError: string | null;
    readonly lastErrorClass: string | null;
    readonly retryAt: string | undefined;
    readonly updatedAt: string;
  };
  /** The newest turn: its id and how it ended (`running` until it has). */
  readonly latestTurn: {
    readonly turnId: string;
    readonly state: "running" | "completed" | "error" | "interrupted";
    readonly requestedAt: string;
    readonly completedAt: string | null;
  } | null;
  readonly modelSelection: ModelSelection;
  /** Background commands, watchers or subagents the last turn left running. */
  readonly backgroundWork: boolean;
  /** Whether the newest run's checkpoint is stored; null when the engine keeps none for it. */
  readonly checkpointSaved: boolean | null;
}

export class GoalThreadsError extends Schema.TaggedError<GoalThreadsError>()("GoalThreadsError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

export interface GoalThreadLaunch {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  readonly runtimeMode: RuntimeMode;
  readonly branch: string | null;
  readonly worktreePath: string | null;
}

export interface GoalThreadSend {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly text: string;
  readonly modelSelection: ModelSelection;
  /** Reuses the command and message receipts when a durable result delivery is replayed. */
  readonly idempotencyKey?: string;
}

export interface GoalThreadBindWorkspace {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  /** Names the durable command, so replaying the same claim cannot bind twice. */
  readonly key: string;
  readonly branch: string;
  readonly worktreePath: string;
}

export class GoalThreads extends Context.Service<
  GoalThreads,
  {
    /** Create the thread and start its first turn. */
    readonly launch: (input: GoalThreadLaunch) => Effect.Effect<void, GoalThreadsError>;
    /** Say something to an existing thread; it queues behind a running turn. */
    readonly send: (input: GoalThreadSend) => Effect.Effect<void, GoalThreadsError>;
    /** Durably point an idle thread at a task's worktree and branch; a no-op when it already is. */
    readonly bindWorkspace: (
      input: GoalThreadBindWorkspace,
    ) => Effect.Effect<void, GoalThreadsError>;
    readonly remove: (threadId: ThreadId) => Effect.Effect<void, GoalThreadsError>;
    /** Ask the running turn to stop. Nothing running is not an error. */
    readonly interrupt: (input: {
      readonly threadId: ThreadId;
      readonly projectId: ProjectId;
    }) => Effect.Effect<void, GoalThreadsError>;
    /** Settle the thread so its provider session is released. Fails when the engine refuses. */
    readonly settle: (threadId: ThreadId) => Effect.Effect<void, GoalThreadsError>;
    readonly read: (threadId: ThreadId) => Effect.Effect<GoalThreadView | undefined>;
    /**
     * Whether the thread still has background commands, watchers or subagents running. When the
     * engine cannot say, it is assumed to: missing evidence must not authorize stopping a worker
     * or removing its files.
     */
    readonly backgroundWork: (threadId: ThreadId) => Effect.Effect<boolean>;
    readonly workspaceRoot: (projectId: ProjectId) => Effect.Effect<string | undefined>;
    /** Threads whose runs changed, as they change. */
    readonly runChanges: Stream.Stream<ThreadId, GoalThreadsError>;
  }
>()("t3/goals/GoalThreads") {}

const iso = (value: DateTime.DateTime | undefined | null) =>
  DateTime.formatIso(value ?? DateTime.makeUnsafe(0));

const failed =
  (operation: string) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    effect.pipe(
      Effect.mapError(
        (error) =>
          new GoalThreadsError({
            operation,
            message: error instanceof Error ? error.message : String(error),
          }),
      ),
    );

export function goalThreadViewOf(
  shell: OrchestrationV2ThreadShell,
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs" | "turnItems">,
): GoalThreadView {
  const messages = projection.messages
    .filter((message) => !message.streaming || message.role === "assistant")
    .map((message) => ({
      ...(message.id !== undefined ? { id: message.id } : {}),
      role: message.role,
      text: message.text,
    }));
  const latestRun = projection.runs.findLast((run) => run.id === shell.latestRunId);
  const running =
    shell.activeRunId !== null ||
    shell.status === "starting" ||
    shell.status === "running" ||
    shell.status === "preparing" ||
    shell.status === "waiting";
  const ended = shell.status === "failed" || latestRun?.status === "failed";
  const interrupted = latestRun?.status === "interrupted" || latestRun?.status === "cancelled";
  return {
    messages,
    // Only the provider's own output counts. The server adds the prompt, workspace preparation and
    // a provider's start-up error, so a desktop app that never loaded still looks like it did work
    // when items are merely counted, and an overseer that never ran spends its rounds.
    madeProgress:
      messages.some((message) => message.role === "assistant") ||
      projection.turnItems.some((item) => item.nativeItemRef !== null),
    session: {
      status: ended && !running ? "error" : running ? "running" : "ready",
      activeTurnId: shell.activeRunId,
      lastError: shell.lastError ?? null,
      lastErrorClass: shell.lastErrorClass ?? null,
      retryAt: shell.usageLimitResetAt ?? undefined,
      updatedAt: iso(shell.updatedAt),
    },
    latestTurn:
      shell.latestRunId === null
        ? null
        : {
            turnId: shell.latestRunId,
            state: running
              ? "running"
              : ended
                ? "error"
                : interrupted
                  ? "interrupted"
                  : "completed",
            requestedAt: iso(latestRun?.requestedAt),
            completedAt: latestRun?.completedAt ? iso(latestRun.completedAt) : null,
          },
    modelSelection: shell.modelSelection,
    backgroundWork: (shell.pendingBackgroundTasks ?? []).length > 0,
    checkpointSaved: latestRun === undefined ? null : latestRun.checkpointId !== null,
  };
}

const make = Effect.gen(function* () {
  const orchestrator = yield* OrchestratorV2.OrchestratorV2;
  const launcher = yield* ThreadLaunch.ThreadLaunchService;
  const management = yield* ThreadManagement.ThreadManagementService;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const crypto = yield* Crypto.Crypto;
  const uuid = crypto.randomUUIDv4().pipe(Effect.orDie);

  return GoalThreads.of({
    launch: (input) =>
      launcher
        .launch({
          commandId: CommandId.make(`goal-launch:${input.threadId}`),
          threadId: input.threadId,
          projectId: input.projectId,
          title: input.title,
          generateTitle: false,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimeMode,
          interactionMode: "default",
          workspaceStrategy:
            input.worktreePath !== null
              ? {
                  type: "existing_worktree",
                  worktreePath: input.worktreePath,
                  ...(input.branch !== null ? { branch: input.branch } : {}),
                }
              : { type: "root", ...(input.branch !== null ? { branch: input.branch } : {}) },
          initialMessage: { text: input.text, attachments: [] },
          createdBy: "agent",
          creationSource: "server",
        })
        .pipe(Effect.asVoid, failed("launch")),
    send: Effect.fn("GoalThreads.send")(
      function* (input) {
        const key = input.idempotencyKey ?? (yield* uuid);
        yield* management.sendToThread({
          projectId: input.projectId,
          commandId: CommandId.make(`goal-send:${key}`),
          threadId: input.threadId,
          messageId: MessageId.make(key),
          text: input.text,
          attachments: [],
          modelSelection: input.modelSelection,
          mode: "queue",
          createdBy: "agent",
          creationSource: "server",
        });
      },
      Effect.asVoid,
      failed("send"),
    ),
    bindWorkspace: (input) =>
      management
        .bindWorkspace({
          projectId: input.projectId,
          commandId: CommandId.make(`goal-bind:${input.threadId}:${input.key}`),
          threadId: input.threadId,
          branch: input.branch,
          worktreePath: input.worktreePath,
        })
        .pipe(Effect.asVoid, failed("bindWorkspace")),
    remove: (threadId) =>
      uuid.pipe(
        Effect.flatMap((key) =>
          orchestrator.dispatch({
            type: "thread.delete",
            commandId: CommandId.make(`goal-cleanup:${threadId}:${key}`),
            threadId,
          }),
        ),
        Effect.asVoid,
        failed("remove"),
      ),
    interrupt: (input) =>
      uuid.pipe(
        Effect.flatMap((key) =>
          management.interruptThread({
            projectId: input.projectId,
            commandId: CommandId.make(`goal-interrupt:${input.threadId}:${key}`),
            threadId: input.threadId,
          }),
        ),
        Effect.asVoid,
        failed("interrupt"),
      ),
    settle: (threadId) =>
      uuid.pipe(
        Effect.flatMap((key) =>
          management.settleThread({
            threadId,
            commandId: CommandId.make(`goal-settle:${threadId}:${key}`),
            byOwnAgent: false,
          }),
        ),
        Effect.asVoid,
        failed("settle"),
      ),
    read: Effect.fn("GoalThreads.read")(
      function* (threadId) {
        const shell = yield* orchestrator.getThreadShell(threadId);
        if (shell === null || shell.deletedAt !== null) return undefined;
        const projection = yield* orchestrator.getThreadProjection(threadId);
        return goalThreadViewOf(shell, projection);
      },
      // @effect-diagnostics-next-line effectSucceedWithVoid:off - callers read the value as `undefined`, not void.
      Effect.catchCause(() => Effect.succeed(undefined)),
    ),
    backgroundWork: (threadId) =>
      orchestrator.getThreadShell(threadId).pipe(
        Effect.map((shell) => (shell?.pendingBackgroundTasks ?? []).length > 0),
        Effect.catchCause(() => Effect.succeed(true)),
      ),
    workspaceRoot: (projectId) =>
      projects.listShells({ projectIds: [projectId] }).pipe(
        Effect.map((shells) => shells[0]?.workspaceRoot),
        // @effect-diagnostics-next-line effectSucceedWithVoid:off - callers read the value as `undefined`, not void.
        Effect.catchCause(() => Effect.succeed(undefined)),
      ),
    runChanges: orchestrator.streamDomainEvents.pipe(
      Stream.filter((event) => event.type === "run.created" || event.type === "run.updated"),
      Stream.map((event) => event.threadId),
      Stream.mapError(
        (error) => new GoalThreadsError({ operation: "runChanges", message: String(error) }),
      ),
    ),
  });
});

export const layer = Layer.effect(GoalThreads, make);
