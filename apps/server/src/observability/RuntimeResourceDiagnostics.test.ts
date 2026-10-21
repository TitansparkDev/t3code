import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Metric from "effect/Metric";
import * as TestClock from "effect/testing/TestClock";

import * as RuntimeResourceDiagnostics from "./RuntimeResourceDiagnostics.ts";

const testSample: RuntimeResourceDiagnostics.RuntimeResourceSample = {
  sampledAt: "2026-10-21T00:00:00.000Z",
  rssBytes: 10,
  heapUsedBytes: 5,
  anonymousBytes: 3,
  fileBytes: 2,
  swapBytes: 0,
  cgroupMemoryCurrentBytes: 10,
  cgroupMemoryHighBytes: 20,
  cgroupMemoryMaxBytes: 30,
  cgroupHighEvents: 0,
  cgroupMaxEvents: 0,
  cgroupOomEvents: 0,
  stage: "provider-runtime-active",
  active: [],
  recentlyCancelled: [],
};

describe("RuntimeResourceDiagnostics", () => {
  it.effect("records owned activity and removes it at the runtime lifecycle boundary", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "t3-runtime-diagnostics-" });
      const layer = RuntimeResourceDiagnostics.layerWith(
        directory + "/runtime.ndjson",
        async (active, recentlyCancelled) => ({
          ...testSample,
          active,
          recentlyCancelled,
        }),
      );
      yield* Effect.gen(function* () {
        const diagnostics = yield* RuntimeResourceDiagnostics.RuntimeResourceDiagnostics;
        yield* diagnostics.begin({
          runtimeId: "session/one",
          runId: "run:one",
          tool: "provider-turn",
          brokerTicketId: "ticket-1",
        });
        yield* TestClock.adjust("10 seconds");
        const [sample] = yield* diagnostics.snapshot;
        assert.equal(sample?.stage, "provider-runtime-active");
        assert.isTrue(
          (yield* Metric.snapshot).some(
            (metric) =>
              metric.id === "t3_runtime_resource_samples_total" &&
              metric.attributes?.stage === "provider-runtime-active",
          ),
        );
        assert.deepEqual(
          sample?.active.map(({ runtimeId, runId, tool, brokerTicketId }) => ({
            runtimeId,
            runId,
            tool,
            brokerTicketId,
          })),
          [
            {
              runtimeId: "session_one",
              runId: "run:one",
              tool: "provider-turn",
              brokerTicketId: "ticket-1",
            },
          ],
        );
        yield* diagnostics.cancel("session/one", "run:one");
        yield* diagnostics.finish("session/one", "run:one");
        yield* TestClock.adjust("10 seconds");
        const snapshots = yield* diagnostics.snapshot;
        assert.deepEqual(snapshots[0], sample);
        assert.equal(snapshots[1]?.recentlyCancelled[0]?.runtimeId, "session_one");
        assert.isNumber(snapshots[1]?.recentlyCancelled[0]?.cancellationLatencyMs);
      }).pipe(Effect.provide(layer));
      const file = yield* fs.readFileString(directory + "/runtime.ndjson");
      assert.isFalse(file.includes("Continue"));
      assert.include(file, "ticket-1");
      assert.include(file, "cancellationLatencyMs");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it("keeps the in-memory sample ring bounded", () => {
    const samples: Array<RuntimeResourceDiagnostics.RuntimeResourceSample> = [];
    for (let index = 0; index < 513; index++) {
      RuntimeResourceDiagnostics.retainSample(samples, { ...testSample, sampledAt: String(index) });
    }
    assert.lengthOf(samples, 512);
    assert.equal(samples[0]?.sampledAt, "1");
    assert.equal(samples.at(-1)?.sampledAt, "512");
  });
});
