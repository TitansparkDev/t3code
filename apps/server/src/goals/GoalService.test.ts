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
import type { GoalSettings } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";

const PROJECT = ProjectId.make("project-1");
const CODEX = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };
const CLAUDE = { instanceId: ProviderInstanceId.make("claudeAgent"), model: "opus" };

const settings = (overrides: Partial<GoalSettings> = {}): GoalSettings => ({
  name: "Finish PLAN.md",
  projectId: PROJECT,
  agents: [{ modelSelection: CODEX, count: 3 }],
  concurrency: 2,
  maxChats: 10,
  runtimeMode: "full-access",
  autoResume: true,
  standardRules: true,
  ...overrides,
});

const makeHarness = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<OrchestrationCommand>();
  const log: OrchestrationCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  // Subscribed up front so an event published before the loop listens is kept.
  const subscription = yield* PubSub.subscribe(events);
  let eventCount = 0;
  const threadState = yield* Ref.make({ reply: "Done.", turnState: "completed" });
  const hasResume = yield* Ref.make(false);

  const thread = (state: { reply: string; turnState: string }) =>
    ({
      latestTurn: { state: state.turnState },
      messages: [{ role: "assistant", text: state.reply }],
      activities: [],
    }) as unknown as OrchestrationThread;

  const layer = GoalService.layer.pipe(
    Layer.provideMerge(GoalStore.layer),
    Layer.provideMerge(
      Layer.mergeAll(
        Layer.mock(OrchestrationEngineService)({
          dispatch: (command) => Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
          streamDomainEvents: Stream.fromSubscription(subscription),
        }),
        Layer.mock(ProjectionSnapshotQuery)({
          getProjectShells: (ids) =>
            Effect.succeed(
              (ids ?? []).includes(PROJECT)
                ? [{ id: PROJECT, workspaceRoot: "/work" } as never]
                : [],
            ),
          getThreadShellById: () =>
            Ref.get(hasResume).pipe(
              Effect.map((resume) =>
                Option.some({ usageLimitResume: resume ? { nextAttemptAt: null } : null } as never),
              ),
            ),
          getThreadDetailById: () =>
            Ref.get(threadState).pipe(Effect.map((state) => Option.some(thread(state)))),
        }),
        Layer.fresh(ServerConfig.layerTest(process.cwd(), { prefix: "t3code-goals-test-" })),
      ),
    ),
  );

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

  const sessionEvent = (threadId: string, session: Record<string, unknown>) =>
    PubSub.publish(events, {
      sequence: 2,
      eventId: EventId.make(`e-${threadId}-${++eventCount}`),
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
          providerName: "Codex",
          runtimeMode: "full-access",
          lastError: null,
          updatedAt: "2026-10-04T12:00:00.000Z",
          ...session,
        },
      },
    } as unknown as OrchestrationEvent);

  /** The chat starts working, then goes quiet. */
  const runAndFinish = Effect.fn("runAndFinish")(function* (threadId: string) {
    yield* sessionEvent(threadId, { status: "running", activeTurnId: "turn-1" });
    yield* sessionEvent(threadId, { status: "ready", activeTurnId: null });
  });

  return { layer, waitFor, log, threadState, hasResume, sessionEvent, runAndFinish };
});

const threadIdOf = (command: OrchestrationCommand | undefined) =>
  command?.type === "thread.create" ? command.threadId : "";

it.layer(NodeServices.layer)("GoalService", (it) => {
  it.effect("starts one chat per lane, spread across the models by their counts", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const [goal] = yield* service.create(
          settings({
            agents: [
              { modelSelection: CODEX, count: 2 },
              { modelSelection: CLAUDE, count: 1 },
            ],
            concurrency: 3,
          }),
        );
        const turns = yield* harness.waitFor("thread.turn.start", 3);
        expect(
          turns.map((turn) => (turn.type === "thread.turn.start" ? turn.modelSelection : null)),
        ).toEqual([CODEX, CLAUDE, CODEX]);
        expect(goal?.chats.map((chat) => chat.agentIndex)).toEqual([0, 1, 0]);
        const text = turns[0]?.type === "thread.turn.start" ? turns[0].message.text : "";
        expect(text).toContain("Finish PLAN.md");
        expect(text).toContain("own git worktree");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("refuses a setup the server would not accept", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const tooFew = yield* service
          .create(settings({ concurrency: 5, maxChats: 3 }))
          .pipe(Effect.flip);
        expect(tooFew.message).toContain("at least as many");
        const noProject = yield* service
          .create(settings({ projectId: ProjectId.make("gone") }))
          .pipe(Effect.flip);
        expect(noProject.message).toContain("no longer exists");
        expect(yield* service.list).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts the next chat as one finishes, then ends on GOAL COMPLETE", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings());
        const [first, second] = yield* harness.waitFor("thread.create", 2);

        yield* harness.runAndFinish(threadIdOf(first));
        const creates = yield* harness.waitFor("thread.create", 3);
        expect(creates).toHaveLength(3);

        // The next chat says nothing is left: the goal completes and nothing new starts.
        yield* Ref.set(harness.threadState, {
          reply: "Merged.\nGOAL COMPLETE",
          turnState: "completed",
        });
        yield* harness.runAndFinish(threadIdOf(second));
        yield* harness.waitFor("thread.archive", 2);
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("complete");
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(3);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("runs until complete when there is no cap, and stops at a cap otherwise", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, maxChats: 2 }));
        const [first] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(first));
        const [, second] = yield* harness.waitFor("thread.create", 2);
        yield* harness.runAndFinish(threadIdOf(second));
        yield* harness.waitFor("thread.archive", 2);
        const [capped] = yield* service.list;
        expect(capped?.status).toBe("failed");
        expect(capped?.detail).toContain("limit of 2 chats");
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);

        // With no cap, a chat that finished without GOAL COMPLETE is always followed by another.
        yield* service.create(settings({ concurrency: 1, maxChats: null }));
        const [, , third] = yield* harness.waitFor("thread.create", 3);
        yield* harness.runAndFinish(threadIdOf(third));
        yield* harness.waitFor("thread.create", 4);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("does not refill a failed lane and ends the goal when every lane has failed", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* Ref.set(harness.threadState, { reply: "", turnState: "failed" });
        yield* service.create(settings({ concurrency: 1 }));
        const [only] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(only));
        while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("failed");
        expect(goal?.chats.map((chat) => chat.status)).toEqual(["failed"]);
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(1);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("resumes a chat cut off by a usage limit and keeps its lane while it waits", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1 }));
        const [only] = yield* harness.waitFor("thread.create", 1);
        const threadId = threadIdOf(only);
        yield* harness.sessionEvent(threadId, { status: "running", activeTurnId: "turn-1" });
        yield* harness.sessionEvent(threadId, {
          status: "rate-limited",
          activeTurnId: null,
          lastErrorClass: "usage_limit",
          retryAt: "2099-01-01T00:00:00.000Z",
        });
        const [resume] = yield* harness.waitFor("thread.usage-limit-resume.schedule", 1);
        expect(resume).toMatchObject({ threadId, resumeAt: "2099-01-01T00:00:02.000Z" });
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("running");
        expect(goal?.chats[0]).toMatchObject({ status: "running", waitingForLimit: true });

        // When the chat picks the work back up it is no longer waiting.
        yield* harness.sessionEvent(threadId, { status: "running", activeTurnId: "turn-2" });
        while ((yield* service.list)[0]?.chats[0]?.waitingForLimit) yield* Effect.yieldNow;
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("leaves a usage-limited chat for the person when auto resume is off", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, autoResume: false }));
        const [only] = yield* harness.waitFor("thread.create", 1);
        const threadId = threadIdOf(only);
        yield* harness.sessionEvent(threadId, { status: "running", activeTurnId: "turn-1" });
        yield* harness.sessionEvent(threadId, {
          status: "rate-limited",
          activeTurnId: null,
          lastErrorClass: "usage_limit",
        });
        while (!(yield* service.list)[0]?.chats[0]?.waitingForLimit) yield* Effect.yieldNow;
        expect(
          harness.log.filter((command) => command.type === "thread.usage-limit-resume.schedule"),
        ).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});

it("picks the model furthest below its own count, and nothing once lanes or the cap are used", () => {
  const chat = (status: string, agentIndex: number) => ({
    status,
    agentIndex,
    startedAt: "2026-10-04T12:00:01.000Z",
  });
  const goal = (chats: Array<ReturnType<typeof chat>>, extra = {}) =>
    ({
      status: "running",
      concurrency: 3,
      maxChats: null,
      createdAt: "2026-10-04T12:00:00.000Z",
      agents: [{ count: 2 }, { count: 1 }],
      chats,
      ...extra,
    }) as never;

  expect(GoalService.nextAgentIndex(goal([]))).toBe(0);
  expect(GoalService.nextAgentIndex(goal([chat("running", 0)]))).toBe(1);
  // Every model is at its own count.
  expect(
    GoalService.nextAgentIndex(goal([chat("running", 0), chat("running", 0), chat("running", 1)])),
  ).toBeUndefined();
  // A failed chat closes its lane: 2 running + 1 failed fills 3 lanes.
  expect(
    GoalService.nextAgentIndex(goal([chat("running", 0), chat("running", 1), chat("failed", 0)])),
  ).toBeUndefined();
  expect(
    GoalService.nextAgentIndex(goal([chat("completed", 0), chat("completed", 0)], { maxChats: 2 })),
  ).toBeUndefined();
  expect(GoalService.nextAgentIndex(goal([], { status: "stopped" }))).toBeUndefined();
});
