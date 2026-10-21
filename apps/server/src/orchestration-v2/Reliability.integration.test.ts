import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import {
  processIsLive,
  ResourceBroker,
  TYPECHECK_DEMAND_MB,
} from "../../../../packages/agent-queue-core/src/resourceBroker.ts";
import {
  inferResourceDemands,
  runUnderBroker,
} from "../../../../packages/agent-queue-core/src/resourceRunner.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderRuntimeRecovery from "./ProviderRuntimeRecoveryService.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId: providerInstanceId, model: "gpt-5.4" };

const runtimeLayer = (dbPath: string) =>
  ProviderRuntimeRecovery.layer.pipe(
    Layer.provideMerge(
      EventSink.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            EventStore.layer,
            ProjectionStore.layer,
            EffectOutbox.layer,
            IdAllocator.layer,
          ).pipe(
            Layer.provideMerge(
              SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
            ),
          ),
        ),
      ),
    ),
    Layer.provide(ServerSettings.layerTest()),
  );

const seedLostStart = Effect.fn(function* (worktreePath: string) {
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const outbox = yield* EffectOutbox.EffectOutboxV2;
  const now = yield* DateTime.now;
  const threadId = ThreadId.make("thread:reliability:reconstructed");
  const runId = RunId.make("run:reliability:lost-start");
  const messageId = MessageId.make("message:reliability:queued");
  const thread: OrchestrationV2AppThread = {
    id: threadId,
    projectId: ProjectId.make("project:reliability"),
    title: "Reliability recovery",
    createdBy: "user",
    creationSource: "web",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: "feature/recovery",
    worktreePath,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId,
    modelSelection,
    providerThreadId: null,
    userMessageId: messageId,
    rootNodeId: null,
    activeAttemptId: null,
    status: "starting",
    requestedAt: now,
    startedAt: now,
    completedAt: null,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* projections.apply({
    id: EventId.make("event:reliability:thread"),
    type: "thread.created",
    threadId,
    occurredAt: now,
    payload: thread,
  });
  yield* projections.apply({
    id: EventId.make("event:reliability:run"),
    type: "run.created",
    threadId,
    runId,
    occurredAt: now,
    payload: run,
  });
  yield* projections.apply({
    id: EventId.make("event:reliability:message"),
    type: "message.updated",
    threadId,
    runId,
    occurredAt: now,
    payload: {
      id: messageId,
      threadId,
      runId,
      nodeId: null,
      role: "user",
      text: "Keep this queued message across recovery.",
      attachments: [],
      streaming: false,
      createdAt: now,
      updatedAt: now,
      createdBy: "user",
      creationSource: "server",
    },
  });
  yield* outbox.enqueue([
    {
      id: "effect:reliability:lost-start",
      commandId: CommandId.make("command:reliability:start"),
      threadId,
      request: { type: "provider-turn.start", runId },
    },
    {
      id: "effect:reliability:cleanup",
      commandId: CommandId.make("command:reliability:cleanup"),
      threadId,
      request: { type: "terminal.cleanup" },
    },
  ]);
  const claim = yield* outbox.claimNext({
    workerId: "runtime-before-reconstruction",
    leaseDurationMs: 1_000,
  });
  assert.equal(Option.getOrThrow(claim).id, "effect:reliability:lost-start");
  return { threadId, runId, messageId };
});

it.effect("recovers one lost start from SQLite without losing the queued message or worktree", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs.makeTempDirectory({ prefix: "t3-reliability-" });
    yield* Effect.addFinalizer(() =>
      fs.remove(directory, { recursive: true, force: true }).pipe(Effect.orDie),
    );
    const dbPath = path.join(directory, "state.sqlite");
    const worktreePath = path.join(directory, "worktree");
    yield* fs.makeDirectory(worktreePath);
    yield* fs.writeFileString(path.join(worktreePath, "kept.txt"), "still here");

    yield* Effect.promise(async () => {
      let availableMb = 12_000;
      const broker = new ResourceBroker({
        home: path.join(directory, "resource-broker"),
        now: () => 1_000,
        host: () => ({
          totalMb: 24_000,
          availableMb,
          swapUsedMb: 0,
          swapTotalMb: 8_000,
          cpus: 16,
          load1: 1,
        }),
        config: () => ({
          reserveMb: 1_000,
          resources: { heavy_build: { capacity: 2, memoryMb: 3_500 } },
        }),
      });
      const lockRoot = process.env.AGENTQUEUE_LOCK_ROOT;
      process.env.AGENTQUEUE_LOCK_ROOT = path.join(directory, "resource-locks");
      try {
        const demand = inferResourceDemands("tsc --noEmit");
        assert.deepEqual(demand, [{ name: "heavy_build", memoryMb: TYPECHECK_DEMAND_MB }]);
        const first = broker.enqueue({ resources: demand, pid: process.pid, label: "compiler-a" });
        const second = broker.enqueue({ resources: demand, pid: process.pid, label: "compiler-b" });
        broker.pump();
        assert.equal(broker.get(first.id)?.state, "granted");
        assert.equal(broker.get(second.id)?.state, "waiting");
        availableMb = 20_000;
        broker.pump();
        assert.equal(broker.get(second.id)?.state, "granted");
        broker.finish(first.id, { outcome: "ok" });
        broker.finish(second.id, { outcome: "ok" });

        const child = await runUnderBroker({
          broker,
          resources: demand,
          argv: [process.execPath, "-e", "setInterval(() => {}, 1000)"],
          cwd: directory,
          runMs: 250,
          stdio: "pipe",
        });
        assert.equal(child.kind, "ran");
        if (child.kind !== "ran") return;
        assert.equal(child.result.outcome, "timed-out");
        assert.equal(child.ticket.state, "done");
        assert.isNotNull(child.ticket.pgid);
        assert.isFalse(processIsLive(child.ticket.pgid!));
        assert.equal(
          broker.status().resources.find((resource) => resource.name === "heavy_build")?.active,
          0,
        );
      } finally {
        if (lockRoot === undefined) delete process.env.AGENTQUEUE_LOCK_ROOT;
        else process.env.AGENTQUEUE_LOCK_ROOT = lockRoot;
        broker.close();
      }
    });

    const seeded = yield* Effect.scoped(
      seedLostStart(worktreePath).pipe(Effect.provide(runtimeLayer(dbPath))),
    );
    yield* TestClock.adjust("2 seconds");

    yield* Effect.scoped(
      Effect.gen(function* () {
        const recovery = yield* ProviderRuntimeRecovery.ProviderRuntimeRecoveryService;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const outbox = yield* EffectOutbox.EffectOutboxV2;
        const summary = yield* recovery.recoverOrphanedClaims;
        assert.deepEqual(summary, { requeuedEffects: 0, failedEffects: 1, cancelledRuns: 1 });

        const projection = yield* projections.getThreadProjection(seeded.threadId);
        assert.equal(projection.runs.find((run) => run.id === seeded.runId)?.status, "cancelled");
        assert.equal(projection.thread.worktreePath, worktreePath);
        assert.equal(yield* fs.readFileString(path.join(worktreePath, "kept.txt")), "still here");
        assert.equal(
          projection.messages.find((message) => message.id === seeded.messageId)?.text,
          "Keep this queued message across recovery.",
        );
        assert.equal(
          Option.getOrThrow(yield* outbox.get("effect:reliability:lost-start")).status,
          "failed",
        );
        assert.equal(
          Option.getOrThrow(
            yield* outbox.claimNext({ workerId: "reconstructed", leaseDurationMs: 1_000 }),
          ).request.type,
          "terminal.cleanup",
        );
        assert.deepEqual(yield* recovery.recoverOrphanedClaims, {
          requeuedEffects: 0,
          failedEffects: 0,
          cancelledRuns: 0,
        });
      }).pipe(Effect.provide(runtimeLayer(dbPath))),
    );
  }).pipe(Effect.orDie, Effect.provide(Layer.mergeAll(NodeServices.layer, TestClock.layer()))),
);
