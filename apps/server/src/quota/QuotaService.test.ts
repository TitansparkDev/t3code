import {
  EventId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
  type ProviderRuntimeEvent,
} from "@t3tools/contracts";
import { Effect, Stream } from "effect";
import * as Fiber from "effect/Fiber";
import { describe, expect, it } from "vite-plus/test";

import { QuotaService, layer } from "./QuotaService.ts";

const quotaEvent = (
  usedPercent: number,
  providerInstanceId: ProviderInstanceId = ProviderInstanceId.make("codex_work"),
  createdAt = "2026-08-23T12:00:00.000Z",
): ProviderRuntimeEvent => ({
  type: "account.rate-limits.updated",
  eventId: EventId.make(`quota-${usedPercent}-${createdAt}`),
  provider: ProviderDriverKind.make("codex"),
  providerInstanceId,
  threadId: ThreadId.make("thread-1"),
  createdAt,
  payload: {
    limits: {
      windows: [
        {
          id: "five_hour",
          kind: "session" as const,
          label: "Five hour",
          usedPercent,
          windowDurationMins: 300,
        },
      ],
    },
  },
});

describe("QuotaService", () => {
  it("uses a cold-start seed until a newer live snapshot arrives", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      yield* service.seedSnapshot({
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        groups: [
          {
            key: "default",
            displayName: "Subscription",
            windows: [{ kind: "short", label: "Five hour", usedPercent: 18 }],
          },
        ],
        source: "state-file",
        observedAt: "2026-08-22T12:00:00.000Z",
      });
      yield* service.ingest(quotaEvent(42));
      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(summary.snapshots[0]?.source).toBe("provider-event");
    expect(summary.snapshots[0]?.groups[0]?.windows[0]?.usedPercent).toBe(42);
  });

  it("stores snapshots by provider instance", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      yield* service.ingest(quotaEvent(42));
      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(summary.snapshots).toHaveLength(1);
    expect(summary.snapshots[0]?.providerInstanceId).toBe("codex_work");
    expect(summary.snapshots[0]?.groups[0]?.windows[0]?.usedPercent).toBe(42);
  });

  it("serializes concurrent updates without losing an account", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      yield* Effect.all(
        [
          service.ingest(quotaEvent(31, ProviderInstanceId.make("codex_work"))),
          service.ingest(quotaEvent(64, ProviderInstanceId.make("codex_personal"))),
        ],
        { concurrency: "unbounded" },
      );
      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(summary.snapshots.map((snapshot) => snapshot.providerInstanceId)).toEqual([
      "codex_personal",
      "codex_work",
    ]);
  });

  it("does not publish for unrelated runtime events", async () => {
    const summaries = await Effect.gen(function* () {
      const service = yield* QuotaService;
      const fiber = yield* service.changes.pipe(
        Stream.take(2),
        Stream.runCollect,
        Effect.forkChild,
      );
      yield* Effect.yieldNow;

      yield* service.ingest({
        type: "content.delta",
        eventId: EventId.make("assistant-delta"),
        provider: ProviderDriverKind.make("codex"),
        providerInstanceId: ProviderInstanceId.make("codex_work"),
        threadId: ThreadId.make("thread-1"),
        createdAt: "2026-08-23T12:00:00.000Z",
        payload: { streamKind: "assistant_text", delta: "hello" },
      });
      yield* service.ingest(quotaEvent(43));
      return Array.from(yield* Fiber.join(fiber));
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(summaries).toHaveLength(2);
    expect(summaries[0]?.snapshots).toEqual([]);
    expect(summaries[1]?.snapshots[0]?.groups[0]?.windows[0]?.usedPercent).toBe(43);
  });

  it("rejects stale probe ingestion when turn events bump revision mid-probe", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      const instId = ProviderInstanceId.make("codex_work");

      // 1. Initial state
      yield* service.ingest(quotaEvent(20, instId, "2026-08-23T12:00:00.000Z"));

      // 2. A probe begins, recording an attempt and getting the start revision
      const startRevision = yield* service.recordAttempt(instId);

      // 3. A turn event arrives mid-probe, bumping the revision
      yield* service.ingest(quotaEvent(80, instId, "2026-08-23T12:01:00.000Z"));

      // 4. The probe completes with older/stale data (e.g. 25%)
      yield* service.ingest(quotaEvent(25, instId, "2026-08-23T12:02:00.000Z"), {
        probeStartRevision: startRevision,
      });

      // 5. The state should still show the fresher turn-driven 80%, not the stale 25%
      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(summary.snapshots[0]?.groups[0]?.windows[0]?.usedPercent).toBe(80);
  });

  it("records non-destructive failure without deleting existing quota windows", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      const instId = ProviderInstanceId.make("codex_work");

      // 1. Establish valid quota windows
      yield* service.ingest(quotaEvent(45, instId));

      // 2. Record probe failure
      yield* service.recordFailure(instId, "rate_limited");

      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    const snapshot = summary.snapshots[0];
    expect(snapshot).toBeDefined();
    // Existing windows retained
    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(45);
    // Failure recorded non-destructively
    expect(snapshot?.errorCode).toBe("rate_limited");
    expect(snapshot?.lastAttemptAt).toBeDefined();
  });

  it("coalesces concurrent coordinateRefresh calls into a single probe", async () => {
    let probeCount = 0;
    await Effect.gen(function* () {
      const service = yield* QuotaService;
      const instId = ProviderInstanceId.make("codex_work");

      const probeEffect = Effect.gen(function* () {
        probeCount++;
        yield* Effect.sleep("20 millis");
        const event = quotaEvent(70, instId);
        yield* service.ingest(event);
        return [event] as ReadonlyArray<ProviderRuntimeEvent>;
      });

      yield* Effect.all(
        [
          service.coordinateRefresh(instId, probeEffect),
          service.coordinateRefresh(instId, probeEffect),
          service.coordinateRefresh(instId, probeEffect),
        ],
        { concurrency: "unbounded" },
      );
    }).pipe(Effect.provide(layer), Effect.runPromise);

    expect(probeCount).toBe(1);
  });

  it("coordinateRefresh records classified failure when probe fails", async () => {
    const summary = await Effect.gen(function* () {
      const service = yield* QuotaService;
      const instId = ProviderInstanceId.make("codex_work");

      // Pre-populate quota
      yield* service.ingest(quotaEvent(30, instId));

      // Probe fails with 429
      const failingProbe: Effect.Effect<
        ReadonlyArray<ProviderRuntimeEvent>,
        { status: number }
      > = Effect.fail({ status: 429 });
      yield* service.coordinateRefresh(instId, failingProbe).pipe(Effect.ignore);

      return yield* service.readSummary;
    }).pipe(Effect.provide(layer), Effect.runPromise);

    const snapshot = summary.snapshots[0];
    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(30);
    expect(snapshot?.errorCode).toBe("rate_limited");
    expect(snapshot?.lastAttemptAt).toBeDefined();
  });
});
