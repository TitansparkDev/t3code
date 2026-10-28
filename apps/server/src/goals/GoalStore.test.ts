import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import { ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import { GoalId, type Goal } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerConfig from "../config.ts";
import * as GoalStore from "./GoalStore.ts";

const goal = (id: string): Goal =>
  ({
    id: GoalId.make(id),
    name: `Goal ${id}`,
    projectId: ProjectId.make("project-store"),
    agents: [
      {
        modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5" },
        count: 1,
      },
    ],
    concurrency: 3,
    maxChats: 50,
    runtimeMode: "full-access",
    autoResume: true,
    standardRules: true,
    status: "running",
    createdAt: "2026-10-22T00:00:00.000Z",
    updatedAt: "2026-10-22T00:00:00.000Z",
    chats: [],
  }) as unknown as Goal;

const layer = GoalStore.layer.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-goal-store-test-" })),
  Layer.provideMerge(NodeServices.layer),
);

it.effect("trims a detail that was cut on a space, and drops a blank one", () =>
  Effect.gen(function* () {
    const store = yield* GoalStore.GoalStore;
    yield* store.add(goal("goal-store-1"));
    const trimmed = yield* store.update(GoalId.make("goal-store-1"), (current) => ({
      ...current,
      detail: "Waiting for the machine: memory is low " as never,
    }));
    expect(trimmed?.detail).toBe("Waiting for the machine: memory is low");
    const blank = yield* store.update(GoalId.make("goal-store-1"), (current) => ({
      ...current,
      detail: "   " as never,
    }));
    expect(blank?.detail).toBeUndefined();
  }).pipe(Effect.provide(layer)),
);

it.effect("refuses a write that would not encode, and keeps the goal it could not change", () =>
  Effect.gen(function* () {
    const store = yield* GoalStore.GoalStore;
    yield* store.add(goal("goal-store-3"));
    const exit = yield* store
      .update(GoalId.make("goal-store-3"), (current) => ({ ...current, concurrency: 0 }))
      .pipe(Effect.exit);
    expect(exit._tag).toBe("Failure");
    const [kept] = yield* store.list;
    expect(kept?.concurrency).toBe(3);
  }).pipe(Effect.provide(layer)),
);

it.effect("keeps later writes working after a refused one", () =>
  Effect.gen(function* () {
    const store = yield* GoalStore.GoalStore;
    yield* store.add(goal("goal-store-2"));
    yield* store
      .update(GoalId.make("goal-store-2"), (current) => ({ ...current, concurrency: 0 }))
      .pipe(Effect.exit);
    const updated = yield* store.update(GoalId.make("goal-store-2"), (current) => ({
      ...current,
      detail: "Waiting for a provider.",
    }));
    expect(updated?.detail).toBe("Waiting for a provider.");
  }).pipe(Effect.provide(layer)),
);

it.effect("reopens pending resource receipts and still decodes legacy chats", () =>
  Effect.gen(function* () {
    const store = yield* GoalStore.GoalStore;
    const legacy = {
      threadId: ThreadId.make("thread-legacy"),
      agentIndex: 0,
      status: "running" as const,
      startedAt: "2026-10-22T00:00:00.000Z",
      resumes: 8,
    };
    const pending = {
      ...legacy,
      threadId: ThreadId.make("thread-pending"),
      status: "completed" as const,
      taskOutcome: "waiting" as const,
      resourceDelivery: {
        idempotencyKey: "resource-results:thread-pending:job-1",
        jobIds: ["job-1"],
        text: "stored result",
      },
    };
    yield* store.add({ ...goal("goal-store-receipt"), chats: [legacy, pending] } as Goal);

    const config = yield* ServerConfig.ServerConfig;
    const restartedContext = yield* Layer.build(
      GoalStore.layer.pipe(
        Layer.provide(Layer.succeed(ServerConfig.ServerConfig, config)),
        Layer.provideMerge(NodeServices.layer),
      ),
    );
    const restarted = yield* GoalStore.GoalStore.pipe(Effect.provideContext(restartedContext));
    const [reopened] = yield* restarted.list;

    expect(reopened?.chats[0]).toMatchObject({ resumes: 8 });
    expect(reopened?.chats[0]?.resourceResumes).toBeUndefined();
    expect(reopened?.chats[1]).toMatchObject({
      resourceDelivery: {
        idempotencyKey: "resource-results:thread-pending:job-1",
        jobIds: ["job-1"],
        text: "stored result",
      },
    });
  }).pipe(Effect.provide(layer)),
);
