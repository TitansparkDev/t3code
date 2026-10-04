import {
  CommandId,
  type OrchestrationEvent,
  type ServerSettings as ServerSettingsValue,
  type ThreadId,
  USAGE_LIMIT_AUTO_RESUME_ANY_MODEL,
} from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import type * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import { nextUsageLimitRetryAt } from "../provider/usageLimits.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as OrchestrationEngine from "./Services/OrchestrationEngine.ts";
import * as ProjectionSnapshotQuery from "./Services/ProjectionSnapshotQuery.ts";

export class UsageLimitAutoResumeReactor extends Context.Service<
  UsageLimitAutoResumeReactor,
  {
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
    readonly drain: Effect.Effect<void>;
  }
>()("t3/orchestration/UsageLimitAutoResumeReactor") {}

/** Whether the user chose to resume this provider instance and model on their own. */
export function isUsageLimitAutoResumeEnabled(
  settings: Pick<ServerSettingsValue, "usageLimitAutoResume">,
  modelSelection: { readonly instanceId: string; readonly model: string },
): boolean {
  return settings.usageLimitAutoResume.some(
    (rule) =>
      rule.instanceId === modelSelection.instanceId &&
      (rule.model === USAGE_LIMIT_AUTO_RESUME_ANY_MODEL || rule.model === modelSelection.model),
  );
}

/**
 * Schedules the same resume the usage-limit banner offers, for threads whose
 * provider and model the user ticked in Settings. It reacts only to a thread
 * entering the usage-limit state, so a resume the user cancels stays cancelled.
 * Later attempts reuse the existing retry flow.
 */
export const make = Effect.gen(function* () {
  const engine = yield* OrchestrationEngine.OrchestrationEngineService;
  const snapshots = yield* ProjectionSnapshotQuery.ProjectionSnapshotQuery;
  const settingsService = yield* ServerSettings.ServerSettingsService;

  const schedule = Effect.fn("UsageLimitAutoResumeReactor.schedule")(function* (
    threadId: ThreadId,
  ) {
    const settings = yield* settingsService.getSettings;
    if (settings.usageLimitAutoResume.length === 0) return;
    const thread = yield* snapshots.getThreadShellById(threadId);
    if (Option.isNone(thread)) return;
    const { session, modelSelection } = thread.value;
    if (
      session === null ||
      (session.status !== "error" && session.status !== "rate-limited") ||
      session.lastErrorClass !== "usage_limit" ||
      thread.value.archivedAt !== null ||
      thread.value.settledOverride === "settled" ||
      thread.value.usageLimitResume != null ||
      !isUsageLimitAutoResumeEnabled(settings, modelSelection)
    ) {
      return;
    }
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* engine.dispatch({
      type: "thread.usage-limit-resume.schedule",
      commandId: CommandId.make(`server:usage-limit-auto-resume:${threadId}:${session.updatedAt}`),
      threadId,
      resumeAt: nextUsageLimitRetryAt({
        now,
        attempt: 0,
        ...(session.retryAt !== undefined ? { providerRetryAt: session.retryAt } : {}),
      }),
    });
  });

  const worker = yield* makeDrainableWorker((threadId: ThreadId) =>
    schedule(threadId).pipe(
      Effect.catchCauseIf(
        (cause) => !Cause.hasInterruptsOnly(cause),
        (cause) =>
          Effect.logWarning("usage-limit auto-resume skipped", {
            threadId,
            cause: Cause.pretty(cause),
          }),
      ),
    ),
  );

  const processEvent = (event: OrchestrationEvent) =>
    event.type === "thread.session-set" && event.payload.session.lastErrorClass === "usage_limit"
      ? worker.enqueue(event.payload.threadId)
      : Effect.void;

  const start: UsageLimitAutoResumeReactor["Service"]["start"] = Effect.fn(
    "UsageLimitAutoResumeReactor.start",
  )(function* () {
    const events = yield* engine.subscribeDomainEvents;
    yield* forkParked(Stream.runForEach(events, processEvent));
  });

  return { start, drain: worker.drain } satisfies UsageLimitAutoResumeReactor["Service"];
});

export const layer = Layer.effect(UsageLimitAutoResumeReactor, make);
