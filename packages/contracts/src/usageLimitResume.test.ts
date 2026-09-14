import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

import {
  ClientOrchestrationCommand,
  OrchestrationEvent,
  OrchestrationSession,
} from "./orchestration.ts";

it.effect("decodes usage-limit resume commands and events", () =>
  Effect.gen(function* () {
    const command = yield* Schema.decodeUnknownEffect(ClientOrchestrationCommand)({
      type: "thread.usage-limit-resume.schedule",
      commandId: "command-1",
      threadId: "thread-1",
      resumeAt: "2030-01-02T03:04:05.000Z",
    });
    assert.strictEqual(command.type, "thread.usage-limit-resume.schedule");

    const event = yield* Schema.decodeUnknownEffect(OrchestrationEvent)({
      eventId: "event-1",
      sequence: 1,
      aggregateKind: "thread",
      aggregateId: "thread-1",
      occurredAt: "2030-01-02T03:00:00.000Z",
      commandId: "command-1",
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.usage-limit-resume-scheduled",
      payload: {
        threadId: "thread-1",
        resumeAt: "2030-01-02T03:04:05.000Z",
        attempt: 0,
        updatedAt: "2030-01-02T03:00:00.000Z",
      },
    });
    assert.strictEqual(event.type, "thread.usage-limit-resume-scheduled");

    const session = yield* Schema.decodeUnknownEffect(OrchestrationSession)({
      threadId: "thread-1",
      status: "rate-limited",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: "Provider usage limit reached",
      lastErrorClass: "usage_limit",
      retryAt: "2030-01-02T03:04:05.000Z",
      updatedAt: "2030-01-02T03:00:00.000Z",
    });
    assert.strictEqual(session.lastErrorClass, "usage_limit");
    assert.strictEqual(session.retryAt, "2030-01-02T03:04:05.000Z");
  }),
);
