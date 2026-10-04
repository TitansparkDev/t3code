import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
import { GOAL_COMPLETE_DETAIL, isGoalComplete } from "@t3tools/contracts/scheduledTasks";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as ScheduledTaskRunner from "./ScheduledTaskRunner.ts";
import * as ScheduledTaskStore from "./ScheduledTaskStore.ts";

const codex = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };

/** A finished thread whose last reply is `reply`. */
const finishedThread = (reply: string) =>
  ({
    latestTurn: { state: "completed" },
    activities: [],
    messages: [{ role: "assistant", text: reply }],
  }) as unknown as OrchestrationThread;

const makeHarness = (reply: string) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    // Subscribed up front so an event published before the runner starts listening is kept.
    const subscription = yield* PubSub.subscribe(events);
    const layer = ScheduledTaskRunner.layer.pipe(
      Layer.provideMerge(ScheduledTaskStore.layer),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) => Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
            streamDomainEvents: Stream.fromSubscription(subscription),
          }),
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadDetailById: () => Effect.succeed(Option.some(finishedThread(reply))),
          }),
          Layer.fresh(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3code-scheduled-goal-test-" }),
          ),
        ),
      ),
    );
    const log: OrchestrationCommand[] = [];
    /** Wait until `count` commands of `type` have been dispatched, then return them all. */
    const waitFor = Effect.fn("waitFor")(function* (
      type: OrchestrationCommand["type"],
      count: number,
    ) {
      while (log.filter((command) => command.type === type).length < count) {
        log.push(yield* Queue.take(commands));
      }
      return log.filter((command) => command.type === type);
    });
    const finish = (threadId: string) =>
      PubSub.publish(events, {
        sequence: 2,
        eventId: EventId.make(`finish-${threadId}`),
        aggregateKind: "thread",
        aggregateId: threadId,
        occurredAt: "2026-10-04T12:00:00.000Z",
        commandId: null,
        causationEventId: null,
        correlationId: null,
        metadata: {},
        type: "thread.session-set",
        payload: {
          threadId,
          session: {
            threadId,
            status: "ready",
            providerName: "Codex",
            runtimeMode: "full-access",
            activeTurnId: null,
            lastError: null,
            updatedAt: "2026-10-04T12:00:00.000Z",
          },
        },
      } as unknown as OrchestrationEvent);
    return { layer, waitFor, finish, log };
  });

it.layer(NodeServices.layer)("goal runs", (it) => {
  it.effect("starts the next thread in a lane as each one finishes, up to the cap", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("Done with this item.");
      yield* Effect.gen(function* () {
        const store = yield* ScheduledTaskStore.ScheduledTaskStore;
        const runner = yield* ScheduledTaskRunner.ScheduledTaskRunner;
        const [task] = yield* store.save({
          name: "Plan",
          prompt: "Work through PLAN.md.",
          projectId: ProjectId.make("project-1"),
          targets: [codex],
          schedule: { timeOfDay: "05:00", daysOfWeek: [] },
          enabled: true,
          goal: { lanes: 2, maxThreads: 3 },
        });
        yield* Effect.forkScoped(runner.loop);
        // Let start-up recovery finish first; it fails any run it finds half-started.
        yield* Effect.yieldNow;
        yield* runner.runNow(task!.id);

        const [first, second] = yield* harness.waitFor("thread.create", 2);
        const threadId = (command: OrchestrationCommand | undefined) =>
          command?.type === "thread.create" ? command.threadId : "";

        // The first lane finishes; its replacement is the third and last thread.
        yield* harness.finish(threadId(first));
        const [, , third] = yield* harness.waitFor("thread.create", 3);
        const turns = yield* harness.waitFor("thread.turn.start", 3);
        expect(turns[2]?.type === "thread.turn.start" && turns[2].message.text).toContain(
          "Work through PLAN.md.",
        );

        // The cap is reached, so finishing the other threads starts nothing.
        yield* harness.finish(threadId(second));
        yield* harness.finish(threadId(third));
        yield* harness.waitFor("thread.archive", 3);
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(3);
        const [stored] = yield* store.list;
        expect(stored?.runHistory?.[0]?.targets).toHaveLength(3);
        expect(isGoalComplete(stored!)).toBe(false);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("stops refilling and records completion when the agent says nothing is left", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness("Everything is merged.\nGOAL COMPLETE");
      yield* Effect.gen(function* () {
        const store = yield* ScheduledTaskStore.ScheduledTaskStore;
        const runner = yield* ScheduledTaskRunner.ScheduledTaskRunner;
        const [task] = yield* store.save({
          name: "Plan",
          prompt: "Work through PLAN.md.",
          projectId: ProjectId.make("project-1"),
          targets: [codex],
          schedule: { timeOfDay: "05:00", daysOfWeek: [] },
          enabled: true,
          goal: { lanes: 1, maxThreads: 5 },
        });
        yield* Effect.forkScoped(runner.loop);
        // Let start-up recovery finish first; it fails any run it finds half-started.
        yield* Effect.yieldNow;
        yield* runner.runNow(task!.id);
        const [only] = yield* harness.waitFor("thread.create", 1);
        yield* harness.finish(only?.type === "thread.create" ? only.threadId : "");
        // The thread is archived last, after the run has been updated.
        yield* harness.waitFor("thread.archive", 1);

        const [stored] = yield* store.list;
        expect(stored?.runHistory?.[0]?.targets).toHaveLength(1);
        expect(stored?.runHistory?.[0]?.detail).toBe(GOAL_COMPLETE_DETAIL);
        expect(stored?.runHistory?.[0]?.status).toBe("completed");
        expect(stored?.enabled).toBe(true);
        expect(isGoalComplete(stored!)).toBe(true);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});
