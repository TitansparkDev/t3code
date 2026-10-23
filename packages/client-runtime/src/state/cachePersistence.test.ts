import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as TestClock from "effect/testing/TestClock";

import { runCachePersistence, type CachePersistenceItem } from "./cachePersistence.ts";

describe("thread cache persistence lane", () => {
  it.effect("coalesces steady updates and flushes settled data immediately", () =>
    Effect.gen(function* () {
      const updates = yield* Queue.sliding<CachePersistenceItem<number>>(1);
      const writes = yield* Queue.unbounded<number>();
      const worker = yield* Effect.forkScoped(
        runCachePersistence(updates, (value) => Queue.offer(writes, value).pipe(Effect.asVoid)),
      );

      yield* Queue.offer(updates, { snapshot: 1 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      expect(yield* Queue.take(writes)).toBe(1);

      yield* Queue.offer(updates, { snapshot: 2 });
      yield* Queue.offer(updates, { snapshot: 3 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("9 seconds");
      expect((yield* Queue.poll(writes))._tag).toBe("None");
      yield* Queue.offer(updates, { snapshot: 4, flush: true });
      expect(yield* Queue.take(writes)).toBe(4);

      yield* Fiber.interrupt(worker);
    }),
  );

  it.effect("writes the latest ordinary update at the ten-second steady limit", () =>
    Effect.gen(function* () {
      const updates = yield* Queue.sliding<CachePersistenceItem<number>>(1);
      const writes = yield* Queue.unbounded<number>();
      const worker = yield* Effect.forkScoped(
        runCachePersistence(updates, (value) => Queue.offer(writes, value).pipe(Effect.asVoid)),
      );

      yield* Queue.offer(updates, { snapshot: 1 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("500 millis");
      expect(yield* Queue.take(writes)).toBe(1);
      yield* Queue.offer(updates, { snapshot: 2 });
      yield* Effect.yieldNow;
      yield* TestClock.adjust("10 seconds");
      expect(yield* Queue.take(writes)).toBe(2);
      yield* Fiber.interrupt(worker);
    }),
  );
});
