import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { report } from "./mobile-thread-performance.ts";
import {
  ThreadOpenTraceRecorder,
  threadOpenTraceKey,
} from "../packages/client-runtime/src/state/threadOpenPerformance.ts";

it("builds isolated v2 fixture workloads across the RTT, bandwidth and cache matrix", () => {
  const result = report() as {
    readonly fixtures: ReadonlyArray<{
      readonly name: string;
      readonly items: number;
      readonly bytes: number;
    }>;
    readonly counts: { readonly scenarios: number; readonly uniqueRowsPerViewportMaximum: number };
    readonly scenarios: ReadonlyArray<{
      readonly cache: string;
      readonly rttMs: number;
      readonly bandwidthMbps: number;
      readonly bytes: number;
      readonly transferBytes: number;
      readonly proxyStagesMs: {
        readonly transferEstimate: number;
        readonly snapshotDecodeProxy: number;
      };
      readonly interruptions: ReadonlyArray<string>;
      readonly routeChanges: ReadonlyArray<string>;
      readonly limitations: ReadonlyArray<string>;
    }>;
  };
  assert.deepStrictEqual(
    result.fixtures.map(({ name }) => name),
    ["small-text", "long-command-heavy", "active-agy", "shell-list-200"],
  );
  assert.equal(result.fixtures.find(({ name }) => name === "long-command-heavy")?.items, 10_000);
  assert.equal(result.fixtures.find(({ name }) => name === "shell-list-200")?.items, 200);
  assert.equal(result.counts.scenarios, 144);
  assert.equal(result.counts.uniqueRowsPerViewportMaximum, 48);
  assert.equal(new Set(result.fixtures.map(({ name }) => name)).size, result.fixtures.length);
  assert.deepStrictEqual(
    [...new Set(result.scenarios.map(({ rttMs }) => rttMs))].sort((a, b) => a - b),
    [0, 80, 250],
  );
  assert.deepStrictEqual(
    [...new Set(result.scenarios.map(({ bandwidthMbps }) => bandwidthMbps))].sort((a, b) => a - b),
    [1, 5, 20, 100],
  );
  assert.deepStrictEqual([...new Set(result.scenarios.map(({ cache }) => cache))].sort(), [
    "disk",
    "empty",
    "memory",
  ]);
  for (const scenario of result.scenarios) {
    assert.equal(
      scenario.cache === "memory"
        ? scenario.transferBytes === 0
        : scenario.cache === "disk"
          ? scenario.transferBytes <= 2_048
          : scenario.transferBytes === scenario.bytes,
      true,
    );
    assert.equal(
      scenario.proxyStagesMs.transferEstimate >= scenario.rttMs || scenario.transferBytes === 0,
      true,
    );
    assert.equal(scenario.proxyStagesMs.snapshotDecodeProxy >= 0, true);
    assert.equal(scenario.interruptions.length, 3);
    assert.equal(scenario.routeChanges.length, 3);
    assert.equal(
      scenario.limitations.some((limitation) => limitation.includes("no native paint")),
      true,
    );
  }
});

it("correlates milestones and suppresses duplicate stage marks", () => {
  let time = 0;
  const events: Array<{
    readonly correlationId: string;
    readonly outcome: string;
    readonly stages: object;
  }> = [];
  const trace = new ThreadOpenTraceRecorder(
    "private-route-key",
    () => time,
    (event) => events.push(event),
  );
  time = 10;
  trace.mark("http-start");
  time = 20;
  trace.mark("http-response");
  time = 50;
  trace.mark("http-response");
  trace.mark("snapshot-decode");
  trace.finish();
  const event = events[0]!;
  assert.match(event.correlationId, /^thread-open-\d+$/);
  assert.equal(event.outcome, "complete");
  assert.deepStrictEqual(Object.keys(event.stages), [
    "route-selection",
    "http-start",
    "http-response",
    "snapshot-decode",
  ]);
  assert.equal(JSON.stringify(event).includes("private-route-key"), false);
  assert.equal(JSON.stringify(event).includes("account"), false);
  assert.equal(JSON.stringify(event).includes("token"), false);
});

it("uses one scoped key format across route and client-runtime stages", () => {
  assert.equal(threadOpenTraceKey("environment", "thread"), "environment\u0000thread");
});

it.effect("keeps a blocked response in the network stage and cancels without a decode mark", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const response = yield* Deferred.make<void>();
    const events: Array<{
      readonly correlationId: string;
      readonly outcome: string;
      readonly stages: object;
    }> = [];
    let time = 0;
    const trace = new ThreadOpenTraceRecorder(
      "route-a",
      () => time,
      (event) => events.push(event),
    );
    trace.mark("http-start");
    const request = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Effect.sleep("250 millis");
        yield* Deferred.await(response);
        time = 250;
        trace.mark("http-response");
        trace.mark("snapshot-decode");
      }),
    );
    yield* Deferred.await(started);
    yield* TestClock.adjust("250 millis");
    trace.cancel();
    yield* Fiber.interrupt(request);
    const event = events[0]!;
    assert.equal(event.outcome, "cancelled");
    assert.equal(Object.keys(event.stages).includes("snapshot-decode"), false);
    assert.equal(Object.keys(event.stages).includes("http-response"), false);
  }),
);

it.effect("advances injected RTT through Deferred response gates without charging decode", () =>
  Effect.gen(function* () {
    for (const rttMs of [0, 80, 250]) {
      const response = yield* Deferred.make<void>();
      const responseReached = yield* Deferred.make<void>();
      let time = 0;
      const events: Array<{
        readonly correlationId: string;
        readonly outcome: string;
        readonly stages: object;
      }> = [];
      const trace = new ThreadOpenTraceRecorder(
        `route-${rttMs}`,
        () => time,
        (event) => events.push(event),
      );
      trace.mark("http-start");
      const request = yield* Effect.forkChild(
        Effect.gen(function* () {
          yield* Effect.sleep(`${rttMs} millis`);
          yield* Deferred.succeed(responseReached, undefined);
          yield* Deferred.await(response);
          time = rttMs;
          trace.mark("http-response");
          trace.mark("snapshot-decode");
        }),
      );
      yield* TestClock.adjust(`${rttMs} millis`);
      yield* Deferred.await(responseReached);
      assert.equal(Object.keys(events[0]?.stages ?? {}).includes("http-response"), false);
      yield* Deferred.succeed(response, undefined);
      yield* Fiber.join(request);
      trace.finish();
      const stages = events[0]?.stages as Record<string, { readonly durationMs: number }>;
      assert.equal(stages["http-response"]?.durationMs, rttMs);
      assert.equal(stages["snapshot-decode"]?.durationMs, 0);
    }
  }),
);

it.effect("drops a stale route trace when a route change interrupts its request", () =>
  Effect.gen(function* () {
    const started = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const events: Array<{
      readonly correlationId: string;
      readonly outcome: string;
      readonly stages: object;
    }> = [];
    const oldTrace = new ThreadOpenTraceRecorder(
      "route-a",
      () => 1,
      (event) => events.push(event),
    );
    const newTrace = new ThreadOpenTraceRecorder(
      "route-b",
      () => 2,
      (event) => events.push(event),
    );
    const request = yield* Effect.forkChild(
      Effect.gen(function* () {
        yield* Deferred.succeed(started, undefined);
        yield* Deferred.await(finish);
        oldTrace.mark("http-response");
      }),
    );
    yield* Deferred.await(started);
    oldTrace.cancel();
    newTrace.mark("route-selection");
    yield* Fiber.interrupt(request);
    newTrace.cancel();
    assert.deepStrictEqual(
      events.map(({ outcome }) => outcome),
      ["cancelled", "cancelled"],
    );
    assert.notEqual(events[0]?.correlationId, events[1]?.correlationId);
  }),
);
