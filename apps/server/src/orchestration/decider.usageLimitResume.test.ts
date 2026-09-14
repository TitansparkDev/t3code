import {
  CommandId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationReadModel,
  type OrchestrationSession,
  type OrchestrationThread,
} from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { decideOrchestrationCommand } from "./decider.ts";
import { projectEvent } from "./projector.ts";

const NOW = "2026-01-01T00:00:00.000Z";
const FUTURE = "1970-01-02T00:00:00.000Z";
const LATER = "1970-01-03T00:00:00.000Z";

function makeReadModel(
  usageLimitResume: OrchestrationThread["usageLimitResume"] = null,
  session: OrchestrationSession | null = {
    threadId: ThreadId.make("thread-1"),
    status: "error",
    providerName: "codex",
    runtimeMode: "full-access",
    activeTurnId: null,
    lastError: "Provider usage limit reached",
    lastErrorClass: "usage_limit",
    updatedAt: NOW,
  },
): OrchestrationReadModel {
  return {
    snapshotSequence: 0,
    projects: [],
    threads: [
      {
        id: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        title: "Thread",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.4",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        pullRequests: [],
        latestTurn: null,
        createdAt: NOW,
        updatedAt: NOW,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        deletedAt: null,
        messages: [],
        proposedPlans: [],
        activities: [],
        checkpoints: [],
        session,
        usageLimitResume,
      },
    ],
    updatedAt: NOW,
  };
}

it.layer(NodeServices.layer)("usage-limit resume decider", (it) => {
  it.effect("schedules a future retry only for a usage-limited session", () =>
    Effect.gen(function* () {
      const event = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-schedule"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FUTURE,
        },
        readModel: makeReadModel(),
      });
      const scheduledEvent = Array.isArray(event) ? event[0] : event;
      expect(scheduledEvent?.type).toBe("thread.usage-limit-resume-scheduled");
      if (scheduledEvent?.type === "thread.usage-limit-resume-scheduled") {
        expect(scheduledEvent.payload.attempt).toBe(0);
        expect(scheduledEvent.payload.resumeAt).toBe(FUTURE);
      }
    }),
  );

  it.effect("accepts only the current due attempt and persists its in-flight state", () =>
    Effect.gen(function* () {
      const scheduled = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-schedule-project"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FUTURE,
        },
        readModel: makeReadModel(),
      });
      const scheduledEvent = Array.isArray(scheduled) ? scheduled[0]! : scheduled;
      const scheduledModel = yield* projectEvent(makeReadModel(), {
        ...scheduledEvent,
        sequence: 1,
      });
      const attempted = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.attempt",
          commandId: CommandId.make("cmd-attempt"),
          threadId: ThreadId.make("thread-1"),
          expectedAttemptAt: FUTURE,
          createdAt: LATER,
        },
        readModel: scheduledModel,
      });
      const attemptedEvent = Array.isArray(attempted) ? attempted[0] : attempted;
      expect(attemptedEvent?.type).toBe("thread.usage-limit-resume-attempted");
      if (attemptedEvent?.type === "thread.usage-limit-resume-attempted") {
        expect(attemptedEvent.payload.shouldResume).toBe(true);
        expect(attemptedEvent.payload.attempt).toBe(0);
      }
    }),
  );

  it.effect("rejects scheduling when the session is not usage-limited", () =>
    Effect.gen(function* () {
      const error = yield* decideOrchestrationCommand({
        command: {
          type: "thread.usage-limit-resume.schedule",
          commandId: CommandId.make("cmd-not-eligible"),
          threadId: ThreadId.make("thread-1"),
          resumeAt: FUTURE,
        },
        readModel: makeReadModel(null, {
          ...makeReadModel().threads[0]!.session!,
          status: "error",
          lastErrorClass: "provider_error",
        }),
      }).pipe(Effect.flip);
      expect(error._tag).toBe("OrchestrationCommandInvariantError");
    }),
  );
});
