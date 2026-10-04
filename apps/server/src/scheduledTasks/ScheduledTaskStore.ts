/**
 * Persistence for scheduled tasks.
 *
 * A flat JSON file beside the other environment-owned state, not an
 * orchestration aggregate: a task is configuration for the machine, like
 * provider settings, and nothing about it needs the event log's history or
 * cross-client replay. Runs it produces are ordinary threads, and those *are*
 * event-sourced.
 *
 * Reads are tolerant and writes are whole-file: the list is small, edited by
 * hand at human speed, and a partially applied write would be worse than a
 * rewrite.
 *
 * @module scheduledTasks/ScheduledTaskStore
 */
import {
  ScheduledTask,
  ScheduledTaskId,
  type ScheduledTaskDraft,
  type ScheduledTaskLastRun,
  type ScheduledTaskRun,
  type ScheduledTaskRunTarget,
  type ScheduledTaskRunTrigger,
  type ScheduledTaskRunUpdate,
} from "@t3tools/contracts/scheduledTasks";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../config.ts";

const decodeTask = Schema.decodeUnknownOption(ScheduledTask);
const encodeTask = Schema.encodeSync(ScheduledTask);

export class ScheduledTaskStore extends Context.Service<
  ScheduledTaskStore,
  {
    readonly list: Effect.Effect<ReadonlyArray<ScheduledTask>>;
    /** Create when the draft has no id, otherwise replace that task. */
    readonly save: (draft: ScheduledTaskDraft) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly remove: (id: ScheduledTaskId) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly startRun: (
      id: ScheduledTaskId,
      trigger: ScheduledTaskRunTrigger,
      scheduledFor?: string,
    ) => Effect.Effect<ScheduledTaskRun | undefined>;
    /** Add one more thread to a running goal. Returns its index in the run. */
    readonly appendRunTarget: (
      id: ScheduledTaskId,
      runId: string,
      target: ScheduledTask["targets"][number],
    ) => Effect.Effect<number | undefined>;
    readonly updateRun: (
      id: ScheduledTaskId,
      runId: string,
      update: ScheduledTaskRunUpdate,
    ) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly updateRunTarget: (
      id: ScheduledTaskId,
      runId: string,
      targetIndex: number,
      update: Partial<ScheduledTaskRunTarget>,
    ) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
    readonly recordRun: (
      id: ScheduledTaskId,
      lastRun: ScheduledTaskLastRun,
    ) => Effect.Effect<ReadonlyArray<ScheduledTask>>;
  }
>()("t3/scheduledTasks/ScheduledTaskStore") {}

export const make = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const crypto = yield* Crypto.Crypto;
  // Identifier generation cannot fail in any way the caller could act on, and
  // a store method that reports "could not make a UUID" would only force every
  // call site to handle an impossible case.
  const randomUUID = crypto.randomUUIDv4.pipe(Effect.orDie);
  const serverConfig = yield* ServerConfig;
  const filePath = path.join(serverConfig.stateDir, "scheduled-tasks.json");

  const loaded = yield* fs.readFileString(filePath).pipe(
    Effect.map((contents) => {
      const parsed: unknown = JSON.parse(contents);
      const tasks = Array.isArray(parsed)
        ? parsed
        : ((parsed as { tasks?: unknown } | null)?.tasks ?? []);
      if (!Array.isArray(tasks)) return [] as ReadonlyArray<ScheduledTask>;
      // One unreadable task must not take the rest of the file with it.
      return tasks.flatMap((task) => {
        const decoded = decodeTask(task);
        return decoded._tag === "Some" ? [decoded.value] : [];
      });
    }),
    Effect.orElseSucceed(() => [] as ReadonlyArray<ScheduledTask>),
  );

  const state = yield* Ref.make<ReadonlyArray<ScheduledTask>>(loaded);
  const writeLock = yield* Semaphore.make(1);

  const persist = (tasks: ReadonlyArray<ScheduledTask>): Effect.Effect<void> =>
    fs
      .writeFileString(
        filePath,
        `${JSON.stringify({ tasks: tasks.map((task) => encodeTask(task)) }, null, 2)}\n`,
      )
      .pipe(
        Effect.catch((cause) =>
          Effect.logWarning("scheduled-tasks.persist-failed", { filePath, cause }),
        ),
      );

  const modify = <A>(
    update: (tasks: ReadonlyArray<ScheduledTask>) => {
      readonly next: ReadonlyArray<ScheduledTask>;
      readonly value: A;
    },
  ): Effect.Effect<A> =>
    writeLock.withPermit(
      Effect.gen(function* () {
        const result = yield* Ref.modify(state, (tasks) => {
          const updated = update(tasks);
          return [{ next: updated.next, value: updated.value }, updated.next] as const;
        });
        yield* persist(result.next);
        return result.value;
      }),
    );

  const save = Effect.fn("ScheduledTaskStore.save")(function* (draft: ScheduledTaskDraft) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const generatedId = ScheduledTaskId.make(yield* randomUUID);
    return yield* modify((tasks) => {
      const existing = draft.id ? tasks.find((task) => task.id === draft.id) : undefined;
      const task: ScheduledTask = {
        id: existing?.id ?? generatedId,
        name: draft.name,
        prompt: draft.prompt,
        ...(draft.projectId ? { projectId: draft.projectId } : {}),
        targets: draft.targets,
        schedule: draft.schedule,
        enabled: draft.enabled,
        ...(draft.goal ? { goal: draft.goal } : {}),
        runtimeMode: draft.runtimeMode ?? existing?.runtimeMode ?? "full-access",
        createdAt: existing?.createdAt ?? now,
        updatedAt: now,
        // Run history belongs to the task, not to the edit that changed it.
        ...(existing?.lastRun ? { lastRun: existing.lastRun } : {}),
        ...(existing?.runHistory ? { runHistory: existing.runHistory } : {}),
      };
      return {
        value: existing
          ? tasks.map((entry) => (entry.id === existing.id ? task : entry))
          : [...tasks, task],
        next: existing
          ? tasks.map((entry) => (entry.id === existing.id ? task : entry))
          : [...tasks, task],
      };
    });
  });

  const remove = Effect.fn("ScheduledTaskStore.remove")(function* (id: ScheduledTaskId) {
    return yield* modify((tasks) => ({
      value: tasks.filter((task) => task.id !== id),
      next: tasks.filter((task) => task.id !== id),
    }));
  });

  const startRun = Effect.fn("ScheduledTaskStore.startRun")(function* (
    id: ScheduledTaskId,
    trigger: ScheduledTaskRunTrigger,
    scheduledFor?: string,
  ) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const runId = yield* randomUUID;
    return yield* modify((tasks) => {
      const task = tasks.find((candidate) => candidate.id === id);
      if (!task) return { value: undefined, next: tasks };
      if (task.runHistory?.some((candidate) => candidate.status === "running")) {
        return { value: undefined, next: tasks };
      }
      const run: ScheduledTaskRun = {
        id: runId,
        trigger,
        status: "running",
        startedAt: now,
        ...(scheduledFor ? { scheduledFor } : {}),
        // A goal opens one thread per lane, cycling through the accounts.
        targets: Array.from(
          { length: task.goal ? task.goal.lanes : task.targets.length },
          (_, lane) => ({
            ...task.targets[lane % task.targets.length]!,
            status: "starting" as const,
          }),
        ),
      };
      const runHistory = [run, ...(task.runHistory ?? [])].slice(0, 50);
      const next = tasks.map((candidate) =>
        candidate.id === id
          ? {
              ...candidate,
              // The marker prevents a scheduled slot from being dispatched a
              // second time while its provider turn is still running.
              lastRun: { at: now, outcome: "started" as const, startedTargets: [] },
              runHistory,
            }
          : candidate,
      );
      return { value: run, next };
    });
  });

  const appendRunTarget = Effect.fn("ScheduledTaskStore.appendRunTarget")(function* (
    id: ScheduledTaskId,
    runId: string,
    target: ScheduledTask["targets"][number],
  ) {
    return yield* modify((tasks) => {
      let index: number | undefined;
      const next = tasks.map((task) => {
        if (task.id !== id || !task.runHistory) return task;
        return {
          ...task,
          runHistory: task.runHistory.map((run) => {
            if (run.id !== runId) return run;
            index = run.targets.length;
            return {
              ...run,
              targets: [...run.targets, { ...target, status: "starting" as const }],
            };
          }),
        };
      });
      return { value: index, next };
    });
  });

  const updateRun = Effect.fn("ScheduledTaskStore.updateRun")(function* (
    id: ScheduledTaskId,
    runId: string,
    update: ScheduledTaskRunUpdate,
  ) {
    return yield* modify((tasks) => {
      const next = tasks.map((task) => {
        if (task.id !== id || !task.runHistory) return task;
        return {
          ...task,
          runHistory: task.runHistory.map((run) =>
            run.id !== runId
              ? run
              : {
                  ...run,
                  ...(update.status !== undefined ? { status: update.status } : {}),
                  ...(update.completedAt !== undefined ? { completedAt: update.completedAt } : {}),
                  ...(update.targets !== undefined ? { targets: update.targets } : {}),
                  ...(update.detail !== undefined ? { detail: update.detail } : {}),
                },
          ),
        };
      });
      return { value: next, next };
    });
  });

  const updateRunTarget = Effect.fn("ScheduledTaskStore.updateRunTarget")(function* (
    id: ScheduledTaskId,
    runId: string,
    targetIndex: number,
    update: Partial<ScheduledTaskRunTarget>,
  ) {
    return yield* modify((tasks) => {
      const next = tasks.map((task) => {
        if (task.id !== id || !task.runHistory) return task;
        return {
          ...task,
          runHistory: task.runHistory.map((run) =>
            run.id !== runId
              ? run
              : {
                  ...run,
                  targets: run.targets.map((target, index) =>
                    index !== targetIndex
                      ? target
                      : {
                          ...target,
                          ...(update.instanceId !== undefined
                            ? { instanceId: update.instanceId }
                            : {}),
                          ...(update.model !== undefined ? { model: update.model } : {}),
                          ...(update.options !== undefined ? { options: update.options } : {}),
                          ...(update.threadId !== undefined ? { threadId: update.threadId } : {}),
                          ...(update.status !== undefined ? { status: update.status } : {}),
                          ...(update.startedAt !== undefined
                            ? { startedAt: update.startedAt }
                            : {}),
                          ...(update.completedAt !== undefined
                            ? { completedAt: update.completedAt }
                            : {}),
                          ...(update.durationMs !== undefined
                            ? { durationMs: update.durationMs }
                            : {}),
                          ...(update.quota5h !== undefined ? { quota5h: update.quota5h } : {}),
                          ...(update.windowStatus !== undefined
                            ? { windowStatus: update.windowStatus }
                            : {}),
                          ...(update.detail !== undefined ? { detail: update.detail } : {}),
                        },
                  ),
                },
          ),
        };
      });
      return { value: next, next };
    });
  });

  const recordRun = Effect.fn("ScheduledTaskStore.recordRun")(function* (
    id: ScheduledTaskId,
    lastRun: ScheduledTaskLastRun,
  ) {
    return yield* modify((tasks) => ({
      value: tasks.map((task) => (task.id === id ? { ...task, lastRun } : task)),
      next: tasks.map((task) => (task.id === id ? { ...task, lastRun } : task)),
    }));
  });

  return {
    list: Ref.get(state),
    save,
    remove,
    startRun,
    appendRunTarget,
    updateRun,
    updateRunTarget,
    recordRun,
  } satisfies ScheduledTaskStore["Service"];
});

export const layer = Layer.effect(ScheduledTaskStore, make);

/** In-memory store for tests and for contexts with no state directory. */
export const layerTest = Layer.effect(
  ScheduledTaskStore,
  Effect.gen(function* () {
    const state = yield* Ref.make<ReadonlyArray<ScheduledTask>>([]);
    return {
      list: Ref.get(state),
      save: () => Ref.get(state),
      remove: () => Ref.get(state),
      startRun: () => Effect.succeed(undefined),
      appendRunTarget: () => Effect.succeed(undefined),
      updateRun: () => Ref.get(state),
      updateRunTarget: () => Ref.get(state),
      recordRun: () => Ref.get(state),
    } satisfies ScheduledTaskStore["Service"];
  }),
);
