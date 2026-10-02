import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type OrchestrationCommand,
  type OrchestrationEvent,
  ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../orchestration/Services/OrchestrationEngine.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ScheduledTaskRunner from "./ScheduledTaskRunner.ts";
import * as ScheduledTaskStore from "./ScheduledTaskStore.ts";

it.layer(NodeServices.layer)("ScheduledTaskRunner without a project", (it) => {
  it.effect("runs in the No project folder and archives the finished run", () =>
    Effect.gen(function* () {
      const commands: OrchestrationCommand[] = [];
      const archived = yield* Deferred.make<ThreadId>();
      const events = yield* Queue.unbounded<OrchestrationEvent>();
      const engine = {
        dispatch: (command: OrchestrationCommand) =>
          Effect.gen(function* () {
            commands.push(command);
            if (command.type === "thread.archive") {
              yield* Deferred.succeed(archived, command.threadId);
            }
            return { sequence: commands.length };
          }),
        streamDomainEvents: Stream.fromQueue(events),
      } as unknown as OrchestrationEngineShape;
      const projection = {
        getActiveProjectByWorkspaceRoot: () => Effect.succeed(Option.none()),
        getThreadDetailById: () => Effect.succeed(Option.none()),
      } as unknown as ProjectionSnapshotQueryShape;

      const layer = ScheduledTaskRunner.layer.pipe(
        Layer.provideMerge(ScheduledTaskStore.layer),
        Layer.provideMerge(Layer.succeed(OrchestrationEngineService, engine)),
        Layer.provideMerge(Layer.succeed(ProjectionSnapshotQuery, projection)),
        Layer.provideMerge(
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-scheduled-no-project-" }),
          ),
        ),
      );

      yield* Effect.gen(function* () {
        const store = yield* ScheduledTaskStore.ScheduledTaskStore;
        const runner = yield* ScheduledTaskRunner.ScheduledTaskRunner;
        const config = yield* ServerConfig.ServerConfig;
        yield* Effect.forkScoped(runner.loop);

        const [task] = yield* store.save({
          name: "Open the window",
          prompt: "Say hello.",
          targets: [{ instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.6-sol" }],
          schedule: { timeOfDay: "05:00", daysOfWeek: [] },
          enabled: true,
        });
        yield* runner.runNow(task!.id);

        const projectCreate = commands.find((command) => command.type === "project.create");
        expect(projectCreate?.type === "project.create" && projectCreate.workspaceRoot).toBe(
          NodePath.resolve(config.baseDir, "scratch"),
        );
        const threadCreate = commands.find((command) => command.type === "thread.create");
        expect(
          threadCreate?.type === "thread.create" &&
            projectCreate?.type === "project.create" &&
            threadCreate.projectId === projectCreate.projectId,
        ).toBe(true);
        const threadId = threadCreate?.type === "thread.create" ? threadCreate.threadId : null;

        yield* Queue.offer(events, {
          type: "thread.session-set",
          payload: { threadId, session: { status: "ready", activeTurnId: null } },
        } as unknown as OrchestrationEvent);
        expect(yield* Deferred.await(archived)).toBe(threadId);
      }).pipe(Effect.provide(layer), Effect.scoped);
    }),
  );
});
