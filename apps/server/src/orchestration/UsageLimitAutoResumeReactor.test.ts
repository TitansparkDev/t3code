import {
  DEFAULT_SERVER_SETTINGS,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationCommand,
  type OrchestrationEvent,
  type OrchestrationSession,
  type OrchestrationThreadShell,
  type ServerSettings,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import { TestClock } from "effect/testing";

import { ServerActivation } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "./Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "./Services/ProjectionSnapshotQuery.ts";
import * as UsageLimitAutoResumeReactor from "./UsageLimitAutoResumeReactor.ts";

const NOW = "2026-10-04T12:00:00.000Z";
const RESET = "2026-10-04T15:00:00.000Z";
const CODEX = ProviderInstanceId.make("codex");

const usageLimitedSession = (threadId: ThreadId): OrchestrationSession => ({
  threadId,
  status: "rate-limited",
  providerName: "Codex",
  runtimeMode: "full-access",
  activeTurnId: null,
  lastError: "Usage limit reached",
  lastErrorClass: "usage_limit",
  retryAt: RESET,
  updatedAt: NOW,
});

const makeThread = (
  id: string,
  overrides: Partial<OrchestrationThreadShell> = {},
): OrchestrationThreadShell => ({
  id: ThreadId.make(id),
  projectId: ProjectId.make("project"),
  title: id,
  modelSelection: { instanceId: CODEX, model: "gpt-6" },
  runtimeMode: "full-access",
  interactionMode: "default",
  pullRequests: [],
  branch: null,
  worktreePath: null,
  latestTurn: null,
  createdAt: NOW,
  updatedAt: NOW,
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  session: usageLimitedSession(ThreadId.make(id)),
  latestUserMessageAt: NOW,
  hasPendingApprovals: false,
  hasPendingUserInput: false,
  hasActionableProposedPlan: false,
  ...overrides,
});

const sessionSet = (thread: OrchestrationThreadShell): OrchestrationEvent =>
  ({
    sequence: 2,
    eventId: EventId.make(`session-${thread.id}`),
    aggregateKind: "thread",
    aggregateId: thread.id,
    occurredAt: NOW,
    commandId: null,
    causationEventId: null,
    correlationId: null,
    metadata: {},
    type: "thread.session-set",
    payload: { threadId: thread.id, session: thread.session },
  }) as OrchestrationEvent;

const run = (input: {
  readonly thread: OrchestrationThreadShell;
  readonly settings: Partial<ServerSettings>;
}) =>
  Effect.gen(function* () {
    yield* TestClock.setTime(Date.parse(NOW));
    const activation = yield* Deferred.make<void>();
    const commands = yield* Ref.make<ReadonlyArray<OrchestrationCommand>>([]);
    const events = yield* PubSub.unbounded<OrchestrationEvent>();
    const settings = { ...DEFAULT_SERVER_SETTINGS, ...input.settings };
    const layer = UsageLimitAutoResumeReactor.layer.pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(ProjectionSnapshotQuery)({
            getThreadShellById: () => Effect.succeed(Option.some(input.thread)),
          }),
          Layer.mock(OrchestrationEngineService)({
            dispatch: ((command) =>
              Ref.update(commands, (recorded) => [...recorded, command]).pipe(
                Effect.as({ sequence: 1 }),
              )) satisfies OrchestrationEngineShape["dispatch"],
            subscribeDomainEvents: PubSub.subscribe(events).pipe(
              Effect.map((subscription) => Stream.fromSubscription(subscription)),
            ),
          }),
          Layer.succeed(
            ServerSettingsService,
            ServerSettingsService.of({
              start: Effect.void,
              ready: Effect.void,
              getSettings: Effect.succeed(settings),
              updateSettings: () => Effect.succeed(settings),
              streamChanges: Stream.empty,
              subscribeChanges: Effect.succeed(Stream.empty),
            }),
          ),
          Layer.succeed(ServerActivation, Deferred.await(activation)),
        ),
      ),
    );
    return yield* Effect.gen(function* () {
      const reactor = yield* UsageLimitAutoResumeReactor.UsageLimitAutoResumeReactor;
      yield* reactor.start();
      yield* Deferred.succeed(activation, undefined);
      yield* PubSub.publish(events, sessionSet(input.thread));
      // The event is delivered on a forked fiber, so let it run before draining.
      yield* Effect.yieldNow;
      yield* Effect.yieldNow;
      yield* reactor.drain;
      return yield* Ref.get(commands);
    }).pipe(Effect.provide(layer));
  });

describe("UsageLimitAutoResumeReactor", () => {
  it.effect("schedules the resume for a ticked provider and model", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* run({
          thread: makeThread("limited"),
          settings: { usageLimitAutoResume: [{ instanceId: CODEX, model: "gpt-6" }] },
        });
        assert.deepStrictEqual(
          commands.map((command) => [command.type, "resumeAt" in command && command.resumeAt]),
          [["thread.usage-limit-resume.schedule", "2026-10-04T15:00:02.000Z"]],
        );
      }),
    ),
  );

  it.effect("covers every model of an instance with the wildcard", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* run({
          thread: makeThread("limited"),
          settings: { usageLimitAutoResume: [{ instanceId: CODEX, model: "*" }] },
        });
        assert.strictEqual(commands.length, 1);
      }),
    ),
  );

  it.effect("leaves other models, other instances, and unticked settings to the user", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const thread = makeThread("limited");
        for (const usageLimitAutoResume of [
          [],
          [{ instanceId: CODEX, model: "gpt-5" }],
          [{ instanceId: ProviderInstanceId.make("claudeAgent"), model: "gpt-6" }],
        ]) {
          assert.deepStrictEqual(yield* run({ thread, settings: { usageLimitAutoResume } }), []);
        }
      }),
    ),
  );

  it.effect("does not reschedule a resume that already exists or was cancelled", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const commands = yield* run({
          thread: makeThread("limited", { usageLimitResume: { nextAttemptAt: RESET, attempt: 0 } }),
          settings: { usageLimitAutoResume: [{ instanceId: CODEX, model: "*" }] },
        });
        assert.deepStrictEqual(commands, []);
      }),
    ),
  );
});
