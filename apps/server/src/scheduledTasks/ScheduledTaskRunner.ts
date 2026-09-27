// @effect-diagnostics globalDate:off - scheduled slots are serialized as ISO instants.
/**
 * Fires scheduled tasks and keeps their runs out of the way.
 *
 * A run is deliberately an ordinary thread started by an ordinary
 * `thread.turn.start`: the same path a person's message takes, so provider
 * routing, checkpointing and history all work without a parallel code path.
 * The only difference is what happens afterwards — the runner settles the
 * thread once its turn goes quiet, so a scheduled run does not accumulate in
 * the active list. Settling has to wait for the turn to finish because a
 * session coming alive un-settles a thread by design.
 *
 * A run that needs a person still surfaces: an approval or user-input request
 * un-settles the thread through the normal rules, which is the behaviour we
 * want — silent automation must not swallow a blocked agent.
 *
 * @module scheduledTasks/ScheduledTaskRunner
 */
import { CommandId, MessageId, ThreadId, type ProviderInstanceId } from "@t3tools/contracts";
import type { OrchestrationThread, OrchestrationThreadActivity } from "@t3tools/contracts";
import type { AccountQuotaSnapshot } from "@t3tools/contracts/quota";
import {
  isScheduledTaskDue,
  type ScheduledTask,
  type ScheduledTaskId,
  type ScheduledTaskRunTarget,
} from "@t3tools/contracts/scheduledTasks";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import type { OrchestrationEngineShape } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { QuotaService } from "../quota/QuotaService.ts";
import { ProviderService } from "../provider/Services/ProviderService.ts";
import { ScheduledTaskStore } from "./ScheduledTaskStore.ts";

/**
 * How often due tasks are looked for.
 *
 * A minute is the resolution a `HH:MM` schedule promises, and the check is a
 * pure comparison over a handful of records.
 */
export const SCHEDULED_TASK_TICK_MS = 30_000;

interface PendingScheduledTarget {
  readonly taskId: ScheduledTaskId;
  readonly runId: string;
  readonly targetIndex: number;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly previousResetAt?: string;
}

/** Only a provider observation made after the turn can confirm its window. */
export function scheduledTargetQuota(
  snapshot: AccountQuotaSnapshot | undefined,
  driverKind: string | undefined,
  model: string,
  observedAfter?: string,
) {
  if (!snapshot || (observedAfter && Date.parse(snapshot.observedAt) < Date.parse(observedAfter))) {
    return undefined;
  }
  const pool =
    driverKind === "antigravity"
      ? /gemini/i.test(model)
        ? "gemini"
        : /claude|gpt/i.test(model)
          ? "claude-gpt"
          : undefined
      : "default";
  if (!pool) return undefined;
  const group = snapshot.groups.find((candidate) => candidate.key === pool);
  const window = group?.windows.find((candidate) => candidate.kind === "short");
  if (!window?.resetsAt || Date.parse(window.resetsAt) <= Date.parse(snapshot.observedAt)) {
    return undefined;
  }
  return {
    usedPercent: window.usedPercent,
    remainingPercent: Math.max(0, 100 - window.usedPercent),
    resetsAt: window.resetsAt,
    observedAt: snapshot.observedAt,
  };
}

function isTerminalTargetStatus(status: ScheduledTaskRunTarget["status"]): boolean {
  return status === "completed" || status === "failed" || status === "skipped";
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function durationFromThread(thread: OrchestrationThread | undefined): number | undefined {
  if (!thread) return undefined;
  for (let index = thread.activities.length - 1; index >= 0; index -= 1) {
    const activity: OrchestrationThreadActivity | undefined = thread.activities[index];
    if (activity?.kind !== "context-window.updated") continue;
    const durationMs = asRecord(activity.payload)?.durationMs;
    if (typeof durationMs === "number" && Number.isFinite(durationMs) && durationMs >= 0) {
      return durationMs;
    }
  }

  const latestTurn = thread.latestTurn;
  if (!latestTurn?.startedAt || !latestTurn.completedAt) return undefined;
  const durationMs = Date.parse(latestTurn.completedAt) - Date.parse(latestTurn.startedAt);
  return Number.isFinite(durationMs) && durationMs >= 0 ? durationMs : undefined;
}

/**
 * Persist a scheduler-owned thread before starting its provider turn.
 *
 * WebSocket clients may send a bootstrap hint that the transport expands into
 * two commands. The scheduler talks to the engine directly, where that hint is
 * deliberately not interpreted, so it must dispatch the same two commands
 * itself and in this order.
 */
export const dispatchScheduledTaskTarget = Effect.fn(
  "ScheduledTaskRunner.dispatchScheduledTaskTarget",
)(function* (input: {
  readonly dispatch: OrchestrationEngineShape["dispatch"];
  readonly task: ScheduledTask;
  readonly target: ScheduledTask["targets"][number];
  readonly threadId: ThreadId;
  readonly createCommandId: CommandId;
  readonly turnCommandId: CommandId;
  readonly messageId: MessageId;
  readonly createdAt: string;
  /** Persist run routing before a fast provider can emit its terminal event. */
  readonly afterThreadCreated?: Effect.Effect<void>;
}) {
  const modelSelection = {
    instanceId: input.target.instanceId,
    model: input.target.model,
    ...(input.target.options ? { options: input.target.options } : {}),
  };

  yield* input.dispatch({
    type: "thread.create",
    commandId: input.createCommandId,
    threadId: input.threadId,
    projectId: input.task.projectId,
    title: input.task.name,
    modelSelection,
    runtimeMode: input.task.runtimeMode,
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdAt: input.createdAt,
  });
  if (input.afterThreadCreated) yield* input.afterThreadCreated;
  yield* input.dispatch({
    type: "thread.turn.start",
    commandId: input.turnCommandId,
    threadId: input.threadId,
    message: {
      messageId: input.messageId,
      role: "user",
      text: input.task.prompt,
      attachments: [],
    },
    modelSelection,
    titleSeed: input.task.name,
    runtimeMode: input.task.runtimeMode,
    interactionMode: "default",
    createdAt: input.createdAt,
  });
});

export class ScheduledTaskRunner extends Context.Service<
  ScheduledTaskRunner,
  {
    /** Run a task by id, ignoring its schedule. */
    readonly runNow: (id: ScheduledTaskId) => Effect.Effect<void>;
    /** The scheduler itself. Fork it; it never completes. */
    readonly loop: Effect.Effect<void>;
  }
>()("t3/scheduledTasks/ScheduledTaskRunner") {}

export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngineService;
  const crypto = yield* Crypto.Crypto;
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const store = yield* ScheduledTaskStore;
  const projection = yield* Effect.serviceOption(ProjectionSnapshotQuery);
  const quota = yield* Effect.serviceOption(QuotaService);
  const provider = yield* Effect.serviceOption(ProviderService);

  /** Threads started by a run, waiting for their turn to go quiet. */
  const pendingSettles = new Map<ThreadId, PendingScheduledTarget>();
  /** Prevents a manual click and a scheduler tick from starting duplicates. */
  const activeRuns = new Set<ScheduledTaskId>();

  const readQuota = (instanceId: ProviderInstanceId, model: string, observedAfter?: string) =>
    Option.isSome(quota) && Option.isSome(provider)
      ? Effect.gen(function* () {
          const info = yield* provider.value.getInstanceInfo(instanceId);
          const summary = yield* quota.value.readSummary;
          return scheduledTargetQuota(
            summary.snapshots.find((candidate) => candidate.providerInstanceId === instanceId),
            info.driverKind,
            model,
            observedAfter,
          );
        }).pipe(Effect.catchCause(() => Effect.succeed(undefined)))
      : Effect.succeed(undefined);

  /**
   * Start one target's thread. Returns the thread it created, or `undefined`
   * when dispatch failed — one bad account must not stop the others.
   */
  const startTarget = Effect.fn("ScheduledTaskRunner.startTarget")(function* (input: {
    readonly task: ScheduledTask;
    readonly target: ScheduledTask["targets"][number];
    readonly runId: string;
    readonly targetIndex: number;
  }) {
    const previousQuota = yield* readQuota(input.target.instanceId, input.target.model);
    const createdAt = DateTime.formatIso(yield* DateTime.now);
    const threadId = ThreadId.make(yield* randomUUID);
    const pending = {
      taskId: input.task.id,
      runId: input.runId,
      targetIndex: input.targetIndex,
      instanceId: input.target.instanceId,
      model: input.target.model,
      ...(previousQuota?.resetsAt ? { previousResetAt: previousQuota.resetsAt } : {}),
    } satisfies PendingScheduledTarget;
    let threadCreated = false;

    const dispatched = yield* Effect.gen(function* () {
      yield* dispatchScheduledTaskTarget({
        dispatch: (command, options) =>
          engine.dispatch(command, options).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (command.type === "thread.create") threadCreated = true;
              }),
            ),
          ),
        task: input.task,
        target: input.target,
        threadId,
        createCommandId: CommandId.make(`scheduled-create:${yield* randomUUID}`),
        turnCommandId: CommandId.make(`scheduled-turn:${yield* randomUUID}`),
        messageId: MessageId.make(yield* randomUUID),
        createdAt,
        afterThreadCreated: Effect.gen(function* () {
          threadCreated = true;
          yield* store.updateRunTarget(input.task.id, input.runId, input.targetIndex, {
            threadId,
            status: "running",
            startedAt: createdAt,
          });
          pendingSettles.set(threadId, pending);
        }),
      });
      return { threadId, startedAt: createdAt };
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.gen(function* () {
          yield* Effect.logWarning("scheduled-tasks.start-failed", {
            taskId: input.task.id,
            instanceId: input.target.instanceId,
            cause,
          });
          pendingSettles.delete(threadId);
          if (threadCreated) {
            yield* engine
              .dispatch({
                type: "thread.delete",
                commandId: CommandId.make(`scheduled-cleanup:${yield* randomUUID}`),
                threadId,
              })
              .pipe(Effect.ignoreCause({ log: true }));
          }
          return undefined;
        }),
      ),
    );

    return dispatched;
  });

  const readThread = (threadId: ThreadId): Effect.Effect<OrchestrationThread | undefined> =>
    Option.isSome(projection)
      ? projection.value.getThreadDetailById(threadId).pipe(
          Effect.map(Option.getOrUndefined),
          Effect.catchCause(() => Effect.succeed(undefined)),
        )
      : Effect.succeed(undefined);

  const completeRunIfFinished = Effect.fn("ScheduledTaskRunner.completeRunIfFinished")(function* (
    taskId: ScheduledTaskId,
    runId: string,
  ) {
    const task = (yield* store.list).find((candidate) => candidate.id === taskId);
    const run = task?.runHistory?.find((candidate) => candidate.id === runId);
    if (
      !run ||
      run.status !== "running" ||
      !run.targets.every((target) => isTerminalTargetStatus(target.status))
    ) {
      return;
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    const completed = run.targets.some((target) => target.status === "completed");
    const skipped =
      run.targets.length === 0 || run.targets.every((target) => target.status === "skipped");
    yield* store.updateRun(taskId, runId, {
      status: skipped ? "skipped" : completed ? "completed" : "failed",
      completedAt: now,
      ...(!completed && !skipped
        ? { detail: "All provider targets failed to start or finish." }
        : {}),
    });
    activeRuns.delete(taskId);
  });

  const finishTarget = Effect.fn("ScheduledTaskRunner.finishTarget")(function* (
    pending: PendingScheduledTarget,
    threadId: ThreadId,
  ) {
    const thread = yield* readThread(threadId);
    const completedAt = DateTime.formatIso(yield* DateTime.now);
    const failed = thread?.latestTurn?.state !== "completed";
    const refreshStartedAt = DateTime.formatIso(yield* DateTime.now);
    if (!failed && Option.isSome(provider) && Option.isSome(quota)) {
      const events = yield* (
        provider.value.refreshQuota?.(pending.instanceId) ?? Effect.succeed([])
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled-tasks.quota-refresh-failed", {
            instanceId: pending.instanceId,
            cause,
          }).pipe(Effect.as([])),
        ),
      );
      // The provider event subscriber runs separately. Ingest here so the
      // result below reads the refresh that just completed, as the RPC does.
      yield* Effect.forEach(events, quota.value.ingest, { discard: true });
    }
    const quotaSnapshot = failed
      ? undefined
      : yield* readQuota(pending.instanceId, pending.model, refreshStartedAt);
    const windowStatus = !quotaSnapshot
      ? "unverified"
      : pending.previousResetAt === quotaSnapshot.resetsAt
        ? "active"
        : pending.previousResetAt && Date.parse(pending.previousResetAt) <= Date.parse(completedAt)
          ? "opened"
          : "active";
    const update: Partial<ScheduledTaskRunTarget> = {
      status: failed ? "failed" : "completed",
      completedAt,
      ...(thread ? { durationMs: durationFromThread(thread) } : {}),
      ...(quotaSnapshot ? { quota5h: quotaSnapshot } : {}),
      ...(!failed ? { windowStatus } : {}),
      ...(failed ? { detail: "The provider turn did not complete." } : {}),
    };
    yield* store.updateRunTarget(pending.taskId, pending.runId, pending.targetIndex, update);
    yield* completeRunIfFinished(pending.taskId, pending.runId);
  });

  /** Run every target of one task and record the run before dispatching. */
  const runTask = Effect.fn("ScheduledTaskRunner.runTask")(function* (input: {
    readonly task: ScheduledTask;
    readonly trigger: "scheduled" | "manual";
    readonly scheduledFor?: string;
  }) {
    if (activeRuns.has(input.task.id)) return;
    const run = yield* store.startRun(input.task.id, input.trigger, input.scheduledFor);
    if (!run) return;
    activeRuns.add(input.task.id);

    const started = yield* Effect.forEach(
      input.task.targets.map((target, targetIndex) => ({ target, targetIndex })),
      ({ target, targetIndex }) =>
        startTarget({ task: input.task, target, runId: run.id, targetIndex }).pipe(
          Effect.map((result) => ({ target, targetIndex, result })),
        ),
      { concurrency: "unbounded" },
    );

    for (const { targetIndex, result } of started) {
      if (!result) {
        yield* store.updateRunTarget(input.task.id, run.id, targetIndex, {
          status: "failed",
          completedAt: DateTime.formatIso(yield* DateTime.now),
          detail: "Provider turn could not be started.",
        });
      }
    }

    yield* completeRunIfFinished(input.task.id, run.id);
  });

  const runNow = Effect.fn("ScheduledTaskRunner.runNow")(function* (id: ScheduledTaskId) {
    const task = (yield* store.list).find((candidate) => candidate.id === id);
    if (!task) return;
    yield* Effect.logInfo("scheduled-tasks.run-now", { taskId: task.id });
    yield* runTask({ task, trigger: "manual" });
  });

  const tick = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    const due = (yield* store.list).filter((task) => isScheduledTaskDue(task, now));
    yield* Effect.forEach(
      due,
      (task) =>
        Effect.logInfo("scheduled-tasks.firing", { taskId: task.id, name: task.name }).pipe(
          Effect.andThen(
            runTask({
              task,
              trigger: "scheduled",
              scheduledFor: new Date(now).toISOString(),
            }),
          ),
        ),
      { concurrency: "unbounded", discard: true },
    );
  });

  const recoverRuns = Effect.gen(function* () {
    for (const task of yield* store.list) {
      for (const run of task.runHistory ?? []) {
        if (run.status !== "running") continue;
        activeRuns.add(task.id);
        for (const [targetIndex, target] of run.targets.entries()) {
          if (isTerminalTargetStatus(target.status)) continue;
          if (!target.threadId) {
            yield* store.updateRunTarget(task.id, run.id, targetIndex, {
              status: "failed",
              completedAt: DateTime.formatIso(yield* DateTime.now),
              detail: "Interrupted before the provider thread was created.",
            });
            continue;
          }
          const threadId = ThreadId.make(target.threadId);
          const pending = {
            taskId: task.id,
            runId: run.id,
            targetIndex,
            instanceId: target.instanceId,
            model: target.model,
          } satisfies PendingScheduledTarget;

          // A crash can happen after thread.create has been persisted but
          // before thread.turn.start reaches a provider. Do not leave that
          // run looking active forever after a restart.
          if (Option.isSome(projection)) {
            const thread = yield* readThread(threadId);
            const sessionIsBusy =
              thread?.session !== null &&
              thread?.session !== undefined &&
              (thread.session.activeTurnId !== null ||
                thread.session.status === "starting" ||
                thread.session.status === "running");
            if (thread && thread.latestTurn === null && !sessionIsBusy) {
              yield* store.updateRunTarget(task.id, run.id, targetIndex, {
                status: "failed",
                completedAt: DateTime.formatIso(yield* DateTime.now),
                detail: "Interrupted before the provider turn started.",
              });
              continue;
            }
            if (thread && !sessionIsBusy) {
              yield* finishTarget(pending, threadId);
              continue;
            }
          }
          pendingSettles.set(threadId, pending);
        }
        yield* completeRunIfFinished(task.id, run.id);
      }
    }
  });

  /**
   * Settle the threads a run created, once their turn is over.
   *
   * The signal is the thread's session going quiet — no active turn, and a
   * status that is not starting or running. Settling any earlier is pointless:
   * the decider un-settles a thread whose session comes alive.
   */
  const settleFinishedRuns = Stream.runForEach(engine.streamDomainEvents, (event) =>
    Effect.gen(function* () {
      if (event.type !== "thread.session-set") return;
      const { threadId, session } = event.payload;
      const pending = pendingSettles.get(threadId);
      if (!pending) return;
      if (session.activeTurnId !== null) return;
      if (session.status === "starting" || session.status === "running") return;

      pendingSettles.delete(threadId);
      yield* finishTarget(pending, threadId);
      yield* engine
        .dispatch({
          type: "thread.settle",
          commandId: CommandId.make(`scheduled-settle:${yield* randomUUID}`),
          threadId,
        })
        .pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("scheduled-tasks.settle-failed", { threadId, cause }),
          ),
        );
    }),
  );

  const pollDueTasks = tick.pipe(
    Effect.catchCause((cause) => Effect.logWarning("scheduled-tasks.tick-failed", { cause })),
    Effect.repeat(Schedule.spaced(Duration.millis(SCHEDULED_TASK_TICK_MS))),
  );

  const loop = Effect.all(
    [
      recoverRuns.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled-tasks.recovery-failed", { cause }),
        ),
        Effect.andThen(pollDueTasks),
      ),
      settleFinishedRuns.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("scheduled-tasks.settle-stream-failed", { cause }),
        ),
      ),
    ],
    { concurrency: "unbounded", discard: true },
  );

  return ScheduledTaskRunner.of({ runNow, loop });
});

export const layer = Layer.effect(ScheduledTaskRunner, make);

/** Runner that does nothing, for contexts that never fire a task. */
export const layerTest = Layer.succeed(
  ScheduledTaskRunner,
  ScheduledTaskRunner.of({ runNow: () => Effect.void, loop: Effect.void }),
);
