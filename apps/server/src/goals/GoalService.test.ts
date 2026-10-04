import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  CommandId,
  DEFAULT_SERVER_SETTINGS,
  EventId,
  MessageId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ClientOrchestrationCommand,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
} from "@t3tools/contracts";
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
import { ServerSettingsService } from "../serverSettings.ts";
import { TextGeneration } from "../textGeneration/TextGeneration.ts";
import * as GoalService from "./GoalService.ts";
import * as GoalStore from "./GoalStore.ts";

const PROJECT = ProjectId.make("project-1");
const MODEL = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6" };

const turnStart = (text: string): ClientOrchestrationCommand =>
  ({
    type: "thread.turn.start",
    commandId: CommandId.make("c1"),
    threadId: ThreadId.make("origin"),
    message: { messageId: MessageId.make("m1"), role: "user", text, attachments: [] },
    modelSelection: MODEL,
    runtimeMode: "full-access",
    interactionMode: "default",
    createdAt: "2026-10-04T12:00:00.000Z",
  }) as ClientOrchestrationCommand;

const makeHarness = Effect.gen(function* () {
  const commands = yield* Queue.unbounded<OrchestrationCommand>();
  const log: OrchestrationCommand[] = [];
  const events = yield* PubSub.unbounded<OrchestrationEvent>();
  // Subscribed up front so an event published before the loop listens is kept.
  const subscription = yield* PubSub.subscribe(events);
  let eventCount = 0;
  const threadState = yield* Ref.make({ reply: "Done.", turnState: "completed" });

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
          getThreadShellById: () =>
            Effect.succeed(Option.some({ projectId: PROJECT, modelSelection: MODEL } as never)),
          getProjectShells: () =>
            Effect.succeed([{ id: PROJECT, workspaceRoot: "/work/project" } as never]),
          getThreadDetailById: () =>
            Ref.get(threadState).pipe(Effect.map((state) => Option.some(thread(state)))),
        }),
        Layer.mock(TextGeneration)({
          generateThreadTitle: () => Effect.succeed({ title: "Finish the plan" }),
        }),
        Layer.succeed(
          ServerSettingsService,
          ServerSettingsService.of({
            start: Effect.void,
            ready: Effect.void,
            getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
            updateSettings: () => Effect.succeed(DEFAULT_SERVER_SETTINGS),
            streamChanges: Stream.empty,
            subscribeChanges: Effect.succeed(Stream.empty),
          }),
        ),
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

  return { layer, waitFor, log, threadState, sessionEvent, runAndFinish };
});

const threadIdOf = (command: OrchestrationCommand | undefined) =>
  command?.type === "thread.create" ? command.threadId : "";

it.layer(NodeServices.layer)("GoalService", (it) => {
  it.effect("turns !goal into a goal, rewrites the message, and fills the other lanes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const intercepted = yield* service.interceptTurnStart(
          turnStart("!goal x2 finish PLAN.md\nWork the plan."),
        );
        expect(intercepted.type === "thread.turn.start" && intercepted.message.text).toContain(
          "finish PLAN.md\n\nWork the plan.",
        );
        expect(intercepted.type === "thread.turn.start" && intercepted.message.text).toContain(
          "Goal rules",
        );

        // Two lanes: the typed-in chat plus one new chat.
        yield* harness.waitFor("thread.turn.start", 1);
        const [goal] = yield* service.list;
        expect(goal).toMatchObject({
          lanes: 2,
          status: "running",
          description: "finish PLAN.md",
          projectId: PROJECT,
        });
        expect(goal?.chats.map((chat) => chat.origin === true)).toEqual([true, false]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("passes ordinary messages through and explains an empty goal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const ordinary = turnStart("just a message");
        expect(yield* service.interceptTurnStart(ordinary)).toBe(ordinary);
        const error = yield* service.interceptTurnStart(turnStart("!goal")).pipe(Effect.flip);
        expect(error.message).toContain("Say what the goal is");
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
        yield* service.interceptTurnStart(turnStart("!goal x2 finish PLAN.md"));
        const [lane2] = yield* harness.waitFor("thread.create", 1);

        // The typed-in chat finishes normally, so its lane is refilled.
        yield* harness.runAndFinish("origin");
        const creates = yield* harness.waitFor("thread.create", 2);
        expect(creates).toHaveLength(2);

        // The next chat says nothing is left: the goal completes and nothing new starts.
        yield* Ref.set(harness.threadState, {
          reply: "Merged.\nGOAL COMPLETE",
          turnState: "completed",
        });
        yield* harness.runAndFinish(threadIdOf(lane2));
        yield* harness.waitFor("thread.archive", 1);
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("complete");
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);
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
        yield* service.interceptTurnStart(turnStart("!goal x1 finish PLAN.md"));
        yield* harness.runAndFinish("origin");
        // Wait until the goal reaches a final state; no other chat is ever started.
        while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("failed");
        expect(goal?.chats.map((chat) => chat.status)).toEqual(["failed"]);
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(0);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("waits out a usage limit instead of failing the chat", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.interceptTurnStart(turnStart("!goal x1 finish PLAN.md"));
        yield* harness.sessionEvent("origin", { status: "running", activeTurnId: "turn-1" });
        yield* harness.sessionEvent("origin", {
          status: "rate-limited",
          activeTurnId: null,
          lastErrorClass: "usage_limit",
        });
        while (!(yield* service.list)[0]?.chats[0]?.waitingForLimit) yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("running");
        expect(goal?.chats[0]).toMatchObject({ status: "running", waitingForLimit: true });
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );
});

it("starts no more chats than the lanes and the budget allow", () => {
  const base = {
    id: "g",
    status: "running",
    lanes: 3,
    maxChats: 4,
    createdAt: "2026-10-04T12:00:00.000Z",
    chats: [] as Array<{ status: string; startedAt: string }>,
  };
  const chat = (status: string) => ({ status, startedAt: "2026-10-04T12:00:01.000Z" });
  const goal = (chats: Array<{ status: string; startedAt: string }>, extra = {}) =>
    ({ ...base, ...extra, chats }) as never;

  expect(GoalService.chatsToStart(goal([]))).toBe(3);
  expect(GoalService.chatsToStart(goal([chat("running"), chat("completed")]))).toBe(2);
  // A failed chat closes its lane; the budget of 4 caps the rest.
  expect(GoalService.chatsToStart(goal([chat("failed"), chat("completed")]))).toBe(2);
  expect(
    GoalService.chatsToStart(goal([chat("completed"), chat("completed"), chat("completed")])),
  ).toBe(1);
  expect(GoalService.chatsToStart(goal([], { status: "stopped" }))).toBe(0);
});
