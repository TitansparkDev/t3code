import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationThread,
  type ServerProvider,
} from "@t3tools/contracts";
import type { GoalSettings } from "@t3tools/contracts/goals";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import * as ServerConfig from "../config.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProviderRegistry } from "../provider/Services/ProviderRegistry.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { GoalBeads, GoalBeadsError, summarizeBeads } from "./GoalBeads.ts";
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
  // Most tests are about the goal giving up; the overseer has its own tests.
  overseer: false,
  ...overrides,
});

/** A provider the way the registry reports it; `usedPercent` fills one usage window. */
const providerSnapshot = (
  instanceId: string,
  overrides: Record<string, unknown> = {},
): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as unknown as ServerProvider;

const makeHarnessWith = (spacing: number) =>
  Effect.gen(function* () {
    const commands = yield* Queue.unbounded<OrchestrationCommand>();
    const log: OrchestrationCommand[] = [];
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    // Subscribed up front so an event published before the loop listens is kept.
    const subscription = yield* PubSub.subscribe(events);
    let eventCount = 0;
    const threadState = yield* Ref.make({ reply: "Done.", turnState: "completed" });
    const hasResume = yield* Ref.make(false);
    const beadAccesses: string[] = [];
    /** What the provider registry reports; every test provider starts out healthy. */
    const providers = yield* Ref.make<ReadonlyArray<ServerProvider>>([
      providerSnapshot("codex"),
      providerSnapshot("claudeAgent"),
    ]);

    const thread = (state: { reply: string; turnState: string }) =>
      ({
        latestTurn: { state: state.turnState },
        messages: state.reply === "" ? [] : [{ role: "assistant", text: state.reply }],
        activities: [],
      }) as unknown as OrchestrationThread;

    const layer = GoalService.layer.pipe(
      Layer.provideMerge(GoalStore.layer),
      Layer.provideMerge(Layer.succeed(GoalService.StartSpacingMillis, spacing)),
      Layer.provideMerge(
        Layer.succeed(
          GoalBeads,
          GoalBeads.of({
            available: () =>
              Effect.sync(() => {
                beadAccesses.push("available");
                return false;
              }),
            snapshot: () =>
              Effect.suspend(() => {
                beadAccesses.push("snapshot");
                return Effect.fail(new GoalBeadsError({ message: "historical only" }));
              }),
            repoContext: () => Effect.succeed("### PLAN.md\nShip the widget."),
            describe: () =>
              Effect.sync(() => {
                beadAccesses.push("describe");
                return { blocked: [], claimed: [] };
              }),
            statusOf: () =>
              Effect.sync(() => {
                beadAccesses.push("status");
                return "closed";
              }),
            release: () => Effect.sync(() => void beadAccesses.push("release")),
          }),
        ),
      ),
      Layer.provideMerge(
        Layer.mergeAll(
          Layer.mock(OrchestrationEngineService)({
            dispatch: (command) => Queue.offer(commands, command).pipe(Effect.as({ sequence: 1 })),
            streamDomainEvents: Stream.fromSubscription(subscription),
          }),
          Layer.mock(ProviderRegistry)({ getProviders: Ref.get(providers) }),
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
                  Option.some({
                    usageLimitResume: resume ? { nextAttemptAt: null } : null,
                  } as never),
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

    /** Collect every command dispatched so far, so a test can assert one never happened. */
    const drain = Effect.gen(function* () {
      log.push(...(yield* Queue.clear(commands)));
      return log;
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

    /** A chat that says it is stuck is asked once to try again; it says so again and stays stuck. */
    const finishStuck = Effect.fn("finishStuck")(function* (threadId: string) {
      yield* runAndFinish(threadId);
      while (
        !log.some(
          (command) =>
            command.type === "thread.turn.start" &&
            command.threadId === threadId &&
            command.message.text.includes("You said you are stuck or blocked"),
        )
      ) {
        log.push(yield* Queue.take(commands));
      }
      yield* runAndFinish(threadId);
    });

    return {
      layer,
      finishStuck,
      waitFor,
      drain,
      log,
      beadAccesses,
      providers,
      threadState,
      hasResume,
      sessionEvent,
      runAndFinish,
    };
  });

const makeHarness = makeHarnessWith(0);

const textOf = (command: OrchestrationCommand | undefined) =>
  command?.type === "thread.turn.start" ? command.message.text : "";

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
        expect(text).toContain("plan-work select --plan PLAN.md");
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
        while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("complete");
        // Chats are settled, never archived, and carry plain titles.
        expect((yield* harness.drain).some((command) => command.type === "thread.archive")).toBe(
          false,
        );
        expect(
          harness.log.flatMap((command) =>
            command.type === "thread.create" ? [command.title] : [],
          ),
        ).toEqual(["Goal worker #1", "Goal worker #2", "Goal worker #3"]);
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
        while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
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
        // A chat with a problem stays in the thread list for the person to read.
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.archive"),
        ).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps a chat that asks for the person open and holds its lane", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* Ref.set(harness.threadState, {
          reply: "I need a login.\nNEEDS ATTENTION",
          turnState: "completed",
        });
        yield* service.create(settings({ concurrency: 2, maxChats: null }));
        const [first] = yield* harness.waitFor("thread.create", 2);
        yield* harness.finishStuck(threadIdOf(first));
        while ((yield* service.list)[0]?.chats[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("running");
        expect(goal?.chats[0]?.status).toBe("attention");
        // The blocked lane is not refilled: the other chat is still the only one working.
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.archive"),
        ).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("settles a usage-limited chat after it resumes and finishes, without archiving", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, maxChats: 1 }));
        const [only] = yield* harness.waitFor("thread.create", 1);
        const threadId = threadIdOf(only);
        yield* harness.sessionEvent(threadId, { status: "running", activeTurnId: "turn-1" });
        yield* harness.sessionEvent(threadId, {
          status: "rate-limited",
          activeTurnId: null,
          lastErrorClass: "usage_limit",
          retryAt: "2099-01-01T00:00:00.000Z",
        });
        yield* harness.waitFor("thread.usage-limit-resume.schedule", 1);
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.archive"),
        ).toEqual([]);
        // After the limit resets the chat works again and finishes successfully.
        yield* harness.runAndFinish(threadId);
        while ((yield* service.list)[0]?.chats[0]?.status === "running") yield* Effect.yieldNow;
        expect((yield* service.list)[0]?.chats[0]?.status).toBe("completed");
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.archive"),
        ).toEqual([]);
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

  it.effect(
    "frees the lane of a usage-limited chat when auto resume is off, without a problem",
    () =>
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
          while ((yield* service.list)[0]?.chats[0]?.status !== "stopped") yield* Effect.yieldNow;
          expect(
            harness.log.filter((command) => command.type === "thread.usage-limit-resume.schedule"),
          ).toHaveLength(0);
          // Not a failure: the goal keeps running. Its only provider is set aside until the limit resets.
          const [goal] = yield* service.list;
          expect(goal?.status).toBe("running");
          expect(goal?.pauses?.[0]).toMatchObject({ instanceId: "codex", reason: "usage-limit" });
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("skips a provider whose usage is used up and uses the others", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.providers, [
        providerSnapshot("codex", {
          usageLimits: {
            checkedAt: "2026-10-04T12:00:00.000Z",
            windows: [
              {
                id: "weekly",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 100,
                resetsAt: "2099-01-01T00:00:00.000Z",
              },
            ],
          },
        }),
        providerSnapshot("claudeAgent"),
      ]);
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* service.create(
          settings({
            concurrency: 2,
            agents: [
              { modelSelection: CODEX, count: 2 },
              { modelSelection: CLAUDE, count: 2 },
            ],
          }),
        );
        const turns = yield* harness.waitFor("thread.turn.start", 2);
        expect(
          turns.map((turn) =>
            turn.type === "thread.turn.start" ? turn.modelSelection?.instanceId : null,
          ),
        ).toEqual(["claudeAgent", "claudeAgent"]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("waits instead of ending when every provider is out of usage, then carries on", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      const used = providerSnapshot("codex", {
        displayName: "Codex",
        usageLimits: {
          checkedAt: "2026-10-04T12:00:00.000Z",
          windows: [
            {
              id: "weekly",
              kind: "weekly",
              label: "Weekly",
              usedPercent: 100,
              resetsAt: "2099-01-01T00:00:00.000Z",
            },
          ],
        },
      });
      yield* Ref.set(harness.providers, [used]);
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        const [goal] = yield* service.create(settings({ concurrency: 1 }));
        expect(goal?.status).toBe("running");
        expect(goal?.chats).toEqual([]);
        expect(goal?.waitingUntil).toBe("2099-01-01T00:00:00.000Z");
        expect(goal?.detail).toContain("Codex is out of usage");
        // The limit resets; the next look starts a chat and clears the note.
        yield* Ref.set(harness.providers, [providerSnapshot("codex")]);
        yield* TestClock.adjust("6 seconds");
        yield* harness.waitFor("thread.create", 1);
        const [after] = yield* service.list;
        expect(after?.status).toBe("running");
        expect(after?.waitingUntil).toBeUndefined();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "a chat that hits a usage limit before doing anything is dropped and not a problem",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Ref.set(harness.threadState, { reply: "", turnState: "error" });
        yield* Effect.gen(function* () {
          const service = yield* GoalService.GoalService;
          yield* Effect.forkScoped(service.loop);
          yield* Effect.yieldNow;
          yield* service.create(
            settings({
              concurrency: 1,
              stopAfterProblems: 1,
              agents: [
                { modelSelection: CODEX, count: 1 },
                { modelSelection: CLAUDE, count: 1 },
              ],
            }),
          );
          const [first] = yield* harness.waitFor("thread.create", 1);
          const threadId = threadIdOf(first);
          yield* harness.sessionEvent(threadId, {
            status: "rate-limited",
            activeTurnId: null,
            lastErrorClass: "usage_limit",
            retryAt: "2099-01-01T00:00:00.000Z",
          });
          yield* harness.waitFor("thread.delete", 1);
          // The goal goes on with the other provider, and the first one is set aside.
          const turns = yield* harness.waitFor("thread.turn.start", 2);
          expect(
            turns[1]?.type === "thread.turn.start" ? turns[1].modelSelection?.instanceId : "",
          ).toBe("claudeAgent");
          const [goal] = yield* service.list;
          expect(goal?.status).toBe("running");
          expect(goal?.chats[0]?.status).toBe("stopped");
          expect(goal?.pauses?.[0]).toMatchObject({
            instanceId: "codex",
            reason: "usage-limit",
            until: "2099-01-01T00:00:02.000Z",
          });
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("sets a provider aside for a while after its chat fails", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, { reply: "boom", turnState: "error" });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 2, stopAfterProblems: 5 }));
        const [first] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(first));
        while ((yield* service.list)[0]?.chats[0]?.status !== "failed") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.pauses?.[0]).toMatchObject({ instanceId: "codex", reason: "errors" });
        expect(goal?.status).toBe("running");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("keeps a draft without starting it, and starts it on request", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const [draft] = yield* service.create(settings({ name: "  ", maxChats: 1 }), {
          draft: true,
        });
        expect(draft).toMatchObject({ status: "draft", name: "Untitled goal" });
        yield* service.update(draft!.id, settings({ name: "Finish it" }), { draft: true });
        expect((yield* harness.drain).filter((c) => c.type === "thread.create")).toHaveLength(0);
        expect((yield* service.list)[0]).toMatchObject({ status: "draft", name: "Finish it" });
        // A full update is checked like any other and still does not start it.
        const refused = yield* Effect.exit(
          service.update(draft!.id, settings({ name: "", concurrency: 2 })),
        );
        expect(refused._tag).toBe("Failure");
        yield* service.restart(draft!.id);
        yield* harness.waitFor("thread.create", 1);
        expect((yield* service.list)[0]?.status).toBe("running");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starting a goal again forgets old pauses and starts at once", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, { reply: "boom", turnState: "error" });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        const [goal] = yield* service.create(settings({ concurrency: 1, stopAfterProblems: 1 }));
        const [first] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(first));
        while ((yield* service.list)[0]?.status !== "failed") yield* Effect.yieldNow;
        expect((yield* service.list)[0]?.pauses).toHaveLength(1);
        yield* TestClock.adjust("1 second");
        yield* service.restart(goal!.id);
        const [again] = yield* service.list;
        expect(again?.pauses).toBeUndefined();
        expect(again?.status).toBe("running");
        yield* harness.waitFor("thread.create", 2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("asks an overseer when the goal is stuck, and its note reaches the stuck chat", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, { reply: "boom", turnState: "error" });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, stopAfterProblems: 1, overseer: true }));
        const [worker] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(worker));
        const [, overseer] = yield* harness.waitFor("thread.create", 2);
        expect(overseer?.type === "thread.create" ? overseer.title : "").toBe("Goal overseer");
        expect((yield* service.list)[0]?.status).toBe("running");
        const briefing = textOf((yield* harness.waitFor("thread.turn.start", 2))[1]);
        expect(briefing).toContain("OVERSEER: CONTINUE");
        expect(briefing).toContain("boom");
        expect(briefing).toContain("CHAT 1:");
        expect(briefing).toContain("Ship the widget.");

        yield* Ref.set(harness.threadState, {
          reply: "OVERSEER: CONTINUE\nGUIDANCE: Run the install step first.",
          turnState: "completed",
        });
        yield* harness.runAndFinish(threadIdOf(overseer));
        // With no message for the stuck chat in particular, it gets the note meant for everyone.
        const resumed = (yield* harness.waitFor("thread.turn.start", 3))[2];
        expect(resumed?.type === "thread.turn.start" ? resumed.threadId : "").toBe(
          threadIdOf(worker),
        );
        expect(textOf(resumed)).toContain("Run the install step first.");
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("running");
        expect(goal?.guidance).toBe("Run the install step first.");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("sends the overseer's answer to the stuck chat so it continues", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, { reply: "boom", turnState: "error" });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, stopAfterProblems: 1, overseer: true }));
        const [worker] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(worker));
        const [, overseer] = yield* harness.waitFor("thread.create", 2);
        yield* Ref.set(harness.threadState, {
          reply: "OVERSEER: CONTINUE\nCHAT 1: Use option A, then merge.",
          turnState: "completed",
        });
        yield* harness.runAndFinish(threadIdOf(overseer));
        const turns = yield* harness.waitFor("thread.turn.start", 3);
        const resumed = turns[2];
        expect(resumed?.type === "thread.turn.start" ? resumed.threadId : "").toBe(
          threadIdOf(worker),
        );
        expect(textOf(resumed)).toContain("Use option A, then merge.");
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("running");
        expect(goal?.chats[0]?.status).toBe("running");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("asks a worker once to try again on its own before it counts as stuck", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, {
        reply: "Cannot merge.\nNEEDS ATTENTION",
        turnState: "completed",
      });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, stopAfterProblems: 5 }));
        const [worker] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(worker));
        const nudge = (yield* harness.waitFor("thread.turn.start", 2))[1];
        expect(nudge?.type === "thread.turn.start" ? nudge.threadId : "").toBe(threadIdOf(worker));
        expect(textOf(nudge)).toContain("Preserve partial work");
        expect((yield* service.list)[0]?.chats[0]?.status).toBe("running");
        // Stuck again: now it is a real problem and keeps its lane closed.
        yield* harness.runAndFinish(threadIdOf(worker));
        while ((yield* service.list)[0]?.chats[0]?.status === "running") yield* Effect.yieldNow;
        expect((yield* service.list)[0]?.chats[0]?.status).toBe("attention");
        expect(harness.log.filter((command) => command.type === "thread.turn.start")).toHaveLength(
          2,
        );
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("adds agents to a goal and starts it when it was not running", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const [goal] = yield* service.create(
          settings({ concurrency: 1, maxChats: 4, agents: [{ modelSelection: CODEX, count: 1 }] }),
        );
        yield* harness.waitFor("thread.create", 1);
        yield* service.stop(goal!.id);
        const [after] = yield* service.addAgents(goal!.id, 3);
        expect(after?.status).toBe("running");
        expect(after?.concurrency).toBe(4);
        expect(after?.agents[0]?.count).toBe(4);
        expect(after?.maxChats).toBe(7);
        yield* harness.waitFor("thread.create", 4);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ends the goal when the overseer says to stop, and when asked too often", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, { reply: "boom", turnState: "error" });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, stopAfterProblems: 1, overseer: true }));
        const [worker] = yield* harness.waitFor("thread.create", 1);
        yield* harness.runAndFinish(threadIdOf(worker));
        const [, overseer] = yield* harness.waitFor("thread.create", 2);
        yield* Ref.set(harness.threadState, {
          reply: "OVERSEER: STOP\nThe login expired; sign in again.",
          turnState: "completed",
        });
        yield* harness.runAndFinish(threadIdOf(overseer));
        while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("failed");
        expect(goal?.detail).toContain("advised stopping");
        expect(goal?.detail).toContain("sign in again");
        // Starting it again by hand gives it a fresh set of overseer runs.
        yield* service.restart(goal!.id);
        expect((yield* service.list)[0]?.overseerRuns).toBeUndefined();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("ignores historical Beads settings and gives workers the plan-work flow", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        const [goal] = yield* service.create(
          settings({ useBeads: true, concurrency: 1, maxChats: null }),
        );
        expect(goal?.useBeads).toBe(false);
        const [turn] = yield* harness.waitFor("thread.turn.start", 1);
        expect(textOf(turn)).toContain("plan-work select --plan PLAN.md");
        expect(textOf(turn)).toContain("plan-work land --owner-token TOKEN");
        expect(textOf(turn)).not.toContain("bd ");
        expect(textOf(turn)).not.toContain("agent-work");
        expect(harness.beadAccesses).toEqual([]);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect(
    "stops starting agents after several in a row cannot finish, without touching the rest",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeHarness;
        yield* Effect.gen(function* () {
          const service = yield* GoalService.GoalService;
          yield* Effect.forkScoped(service.loop);
          yield* Effect.yieldNow;
          yield* Ref.set(harness.threadState, {
            reply: "Cannot merge.\nNEEDS ATTENTION",
            turnState: "completed",
          });
          yield* service.create(
            settings({
              concurrency: 5,
              agents: [{ modelSelection: CODEX, count: 5 }],
              maxChats: null,
              stopAfterProblems: 2,
            }),
          );
          const creates = yield* harness.waitFor("thread.create", 5);
          yield* harness.finishStuck(threadIdOf(creates[0]));
          yield* harness.finishStuck(threadIdOf(creates[1]));
          while ((yield* service.list)[0]?.status === "running") yield* Effect.yieldNow;
          const [goal] = yield* service.list;
          expect(goal?.detail).toContain("protect your usage");
          expect(goal?.chats.filter((chat) => chat.status === "running")).toHaveLength(3);
          expect(
            (yield* harness.drain).filter((command) => command.type === "thread.turn.interrupt"),
          ).toEqual([]);
        }).pipe(Effect.provide(harness.layer), Effect.scoped);
      }),
  );

  it.effect("holds new agents while a chat reports only blocked work, until another finishes", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* Ref.set(harness.threadState, {
          reply:
            "All waiting.\nBLOCKED TASKS — unfinished work remains, but every piece waits on work that is not done yet.",
          turnState: "completed",
        });
        yield* service.create(settings({ concurrency: 2, maxChats: null }));
        const [first, second] = yield* harness.waitFor("thread.create", 2);
        yield* harness.finishStuck(threadIdOf(first));
        while (!(yield* service.list)[0]?.holdStarts) yield* Effect.yieldNow;
        for (let turn = 0; turn < 20; turn++) yield* Effect.yieldNow;
        const [held] = yield* service.list;
        expect(held?.holdStarts).toBe(true);
        expect(held?.chats.find((chat) => chat.threadId === threadIdOf(first))?.blockedWork).toBe(
          true,
        );
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);

        // Another agent finishing real work frees the blocked tasks: starting resumes.
        yield* Ref.set(harness.threadState, { reply: "Merged.", turnState: "completed" });
        yield* harness.runAndFinish(threadIdOf(second));
        yield* harness.waitFor("thread.create", 3);
        expect((yield* service.list)[0]?.holdStarts).toBeUndefined();
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("asks the Overseer to diagnose a real no-ready-work stall", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Ref.set(harness.threadState, {
        reply:
          "BLOCKED TASKS — unfinished work remains, but every piece waits on a prerequisite that is not done yet.",
        turnState: "completed",
      });
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 1, maxChats: null, overseer: true }));
        const [worker] = yield* harness.waitFor("thread.create", 1);
        yield* harness.finishStuck(threadIdOf(worker));
        const creates = yield* harness.waitFor("thread.create", 2);
        expect(creates).toHaveLength(2);
        expect(creates[1]?.type === "thread.create" ? creates[1].title : "").toBe("Goal overseer");
        const turns = yield* harness.waitFor("thread.turn.start", 3);
        const briefing = textOf(turns[2]);
        expect(briefing).toContain("Stalled: the remaining tasks are blocked");
        expect(briefing).toContain("plan-work recovery");
        expect(briefing).toContain("never take ownership away");
        expect(briefing).not.toContain("RELEASE:");
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("stopping a goal leaves working chats alone and still records them", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(settings({ concurrency: 2 }));
        const [first] = yield* harness.waitFor("thread.create", 2);
        yield* service.stop((yield* service.list)[0]!.id);
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.turn.interrupt"),
        ).toEqual([]);
        yield* harness.runAndFinish(threadIdOf(first));
        while ((yield* service.list)[0]?.chats[0]?.status === "running") yield* Effect.yieldNow;
        const [goal] = yield* service.list;
        expect(goal?.status).toBe("stopped");
        expect(goal?.chats[0]?.status).toBe("completed");
        expect(harness.log.filter((command) => command.type === "thread.create")).toHaveLength(2);
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("applies edited settings to a running goal", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarness;
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* service.create(settings({ concurrency: 1, maxChats: null }));
        yield* harness.waitFor("thread.create", 1);
        const [goal] = yield* service.list;
        const [edited] = yield* service.update(
          goal!.id,
          settings({
            name: "Renamed goal",
            prompt: "Do the new thing.",
            concurrency: 3,
            agents: [{ modelSelection: CODEX, count: 3 }],
            maxChats: null,
          }),
        );
        expect(edited).toMatchObject({
          name: "Renamed goal",
          prompt: "Do the new thing.",
          concurrency: 3,
        });
        const creates = yield* harness.waitFor("thread.create", 3);
        expect(creates).toHaveLength(3);
        const turns = yield* harness.waitFor("thread.turn.start", 3);
        expect(textOf(turns[2])).toContain("Do the new thing.");
      }).pipe(Effect.provide(harness.layer), Effect.scoped);
    }),
  );

  it.effect("starts chats one spacing apart", () =>
    Effect.gen(function* () {
      const harness = yield* makeHarnessWith(15_000);
      yield* Effect.gen(function* () {
        const service = yield* GoalService.GoalService;
        yield* Effect.forkScoped(service.loop);
        yield* Effect.yieldNow;
        yield* service.create(
          settings({ concurrency: 3, agents: [{ modelSelection: CODEX, count: 3 }] }),
        );
        yield* harness.waitFor("thread.create", 1);
        expect(
          (yield* harness.drain).filter((command) => command.type === "thread.create"),
        ).toHaveLength(1);
        yield* TestClock.adjust("16 seconds");
        yield* harness.waitFor("thread.create", 2);
        yield* TestClock.adjust("16 seconds");
        yield* harness.waitFor("thread.create", 3);
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

it("counts chunks from Beads, leaving epics out and treating the rest as blocked", () => {
  const all = JSON.stringify([
    { id: "e", status: "open", issue_type: "epic" },
    { id: "a", status: "closed", issue_type: "task" },
    { id: "b", status: "in_progress", issue_type: "task" },
    { id: "c", status: "open", issue_type: "task", title: "C" },
    { id: "d", status: "open", issue_type: "task" },
  ]);
  const ready = JSON.stringify([{ id: "c", title: "C", status: "open", issue_type: "task" }]);
  expect(summarizeBeads(all, ready)).toEqual({
    ready: [{ id: "c", title: "C" }],
    working: 1,
    blocked: 1,
    done: 1,
  });
  expect(summarizeBeads("not json", "")).toEqual({ ready: [], working: 0, blocked: 0, done: 0 });
});

it("reads a provider's own usage report", () => {
  const now = Date.parse("2026-10-04T12:00:00.000Z");
  const full = (id: string, label: string) => ({
    id,
    kind: "weekly",
    label,
    usedPercent: 100,
    resetsAt: "2026-10-09T00:00:00.000Z",
  });
  const withWindows = (...windows: ReturnType<typeof full>[]) =>
    providerSnapshot("codex", { usageLimits: { checkedAt: "x", windows } });
  expect(GoalService.providerBlock(withWindows(full("primary", "Weekly")), "gpt-6", now)).toEqual({
    until: Date.parse("2026-10-09T00:00:00.000Z"),
    reason: "is out of usage",
  });
  // A window for one model family does not stop the others.
  expect(
    GoalService.providerBlock(withWindows(full("seven_day_opus", "Opus weekly")), "sonnet", now),
  ).toBeUndefined();
  expect(
    GoalService.providerBlock(withWindows(full("seven_day_opus", "Opus weekly")), "opus-4", now),
  ).toBeDefined();
  // A window that has already reset, or is not full, is ignored.
  expect(
    GoalService.providerBlock(
      withWindows({ ...full("primary", "Weekly"), resetsAt: "2026-10-01T00:00:00.000Z" }),
      "gpt-6",
      now,
    ),
  ).toBeUndefined();
  expect(GoalService.providerBlock(undefined, "gpt-6", now)?.reason).toBe("is not set up");
  expect(
    GoalService.providerBlock(
      providerSnapshot("codex", { auth: { status: "unauthenticated" } }),
      "gpt-6",
      now,
    )?.reason,
  ).toBe("is signed out");
});
