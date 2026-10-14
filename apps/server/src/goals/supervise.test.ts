import { expect, it } from "@effect/vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Ref from "effect/Ref";
import * as TestClock from "effect/testing/TestClock";
import { superviseForever } from "./supervise.ts";

it.effect("a loop that dies is started again, so one bad pass cannot end scheduling for good", () =>
  Effect.gen(function* () {
    const runs = yield* Ref.make(0);
    const fiber = yield* Effect.forkChild(
      superviseForever(
        "test",
        Ref.updateAndGet(runs, (n) => n + 1).pipe(
          Effect.flatMap((n) =>
            n <= 2 ? Effect.die(new Error(`defect ${n}`)) : Effect.fail(`typed ${n}`),
          ),
        ),
      ),
    );
    for (let round = 0; round < 6; round++) {
      yield* TestClock.adjust(Duration.seconds(2));
      yield* Effect.yieldNow;
    }
    expect(yield* Ref.get(runs)).toBeGreaterThanOrEqual(5);
    // It is still alive after defects and failures alike, and stops cleanly when told to.
    expect(fiber.pollUnsafe()).toBeUndefined();
    yield* Fiber.interrupt(fiber);
  }),
);
