import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId } from "@t3tools/contracts";
import type { ScheduledTaskDraft } from "@t3tools/contracts/scheduledTasks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as ScheduledTaskStore from "./ScheduledTaskStore.ts";

const draft = (overrides: Partial<ScheduledTaskDraft> = {}): ScheduledTaskDraft => ({
  name: "Open the window",
  prompt: "Say hello.",
  projectId: ProjectId.make("project-1"),
  targets: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" }],
  schedule: { timeOfDay: "05:00", daysOfWeek: [] },
  enabled: true,
  ...overrides,
});

const storeLayer = () =>
  ScheduledTaskStore.layer.pipe(
    Layer.provideMerge(
      Layer.fresh(
        ServerConfig.layerTest(process.cwd(), { prefix: "t3code-scheduled-tasks-test-" }),
      ),
    ),
  );

it.layer(NodeServices.layer)("ScheduledTaskStore", (it) => {
  it.effect("creates, updates in place, and deletes", () =>
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore.ScheduledTaskStore;

      const created = yield* store.save(draft());
      expect(created).toHaveLength(1);
      const task = created[0]!;

      const updated = yield* store.save(draft({ id: task.id, name: "Renamed", enabled: false }));
      // An edit replaces the task rather than adding a second one.
      expect(updated).toHaveLength(1);
      expect(updated[0]?.id).toBe(task.id);
      expect(updated[0]?.name).toBe("Renamed");
      expect(updated[0]?.enabled).toBe(false);
      expect(updated[0]?.createdAt).toBe(task.createdAt);

      expect(yield* store.remove(task.id)).toHaveLength(0);
    }).pipe(Effect.provide(storeLayer())),
  );

  it.effect("keeps run history across edits and survives a reload", () =>
    Effect.gen(function* () {
      const store = yield* ScheduledTaskStore.ScheduledTaskStore;
      const [task] = yield* store.save(draft());
      const run = yield* store.startRun(task!.id, "manual");
      expect(run?.targets[0]?.status).toBe("starting");
      yield* store.updateRunTarget(task!.id, run!.id, 0, {
        threadId: "thread-scheduled-1",
        status: "completed",
        durationMs: 12_345,
        windowStatus: "opened",
      });
      yield* store.updateRun(task!.id, run!.id, {
        status: "completed",
        completedAt: "2026-08-31T05:00:30.000Z",
      });
      yield* store.recordRun(task!.id, {
        at: "2026-08-31T05:00:00.000Z",
        outcome: "started",
        startedTargets: [ProviderInstanceId.make("codex")],
      });
      // Editing the schedule must not erase what the task already did.
      const [edited] = yield* store.save(
        draft({ id: task!.id, schedule: { timeOfDay: "06:30", daysOfWeek: [1, 3] } }),
      );
      expect(edited?.lastRun?.at).toBe("2026-08-31T05:00:00.000Z");
      expect(edited?.runHistory?.[0]?.targets[0]?.threadId).toBe("thread-scheduled-1");

      // A second store over the same state directory reads back what was
      // written, which is what a server restart does.
      const reloadedStore = yield* ScheduledTaskStore.make;
      const reloaded = yield* reloadedStore.list;
      expect(reloaded).toHaveLength(1);
      expect(reloaded[0]?.id).toBe(task!.id);
      expect(reloaded[0]?.schedule.timeOfDay).toBe("06:30");
      expect(reloaded[0]?.lastRun?.outcome).toBe("started");
      expect(reloaded[0]?.runHistory?.[0]?.targets[0]?.windowStatus).toBe("opened");
    }).pipe(Effect.provide(storeLayer())),
  );
});
