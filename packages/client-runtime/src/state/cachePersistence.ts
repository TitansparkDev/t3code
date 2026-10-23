import * as Effect from "effect/Effect";
import * as Clock from "effect/Clock";
import * as Duration from "effect/Duration";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";

export interface CachePersistenceItem<A> {
  readonly snapshot: A;
  readonly flush?: true;
}

function takeLatest<A>(
  queue: Queue.Queue<CachePersistenceItem<A>>,
  delayMs: 500 | 10_000,
  initial?: CachePersistenceItem<A>,
) {
  return Effect.gen(function* () {
    let latest = initial;
    const deadline = (yield* Clock.currentTimeMillis) + delayMs;
    while (true) {
      const remaining = Math.max(0, deadline - (yield* Clock.currentTimeMillis));
      const item = yield* Queue.take(queue).pipe(Effect.timeoutOption(Duration.millis(remaining)));
      if (Option.isNone(item)) return latest;
      latest = item.value;
      if (latest.flush === true) {
        return latest;
      }
    }
  });
}

export const runCachePersistence = Effect.fn("runCachePersistence")(function* <A, E, R>(
  queue: Queue.Queue<CachePersistenceItem<A>>,
  persist: (value: A) => Effect.Effect<void, E, R>,
) {
  let next = yield* Queue.take(queue);
  while (true) {
    if (next.flush !== true) next = (yield* takeLatest(queue, 500, next)) ?? next;
    yield* persist(next.snapshot);
    const pending = yield* takeLatest(queue, 10_000);
    next = pending === undefined ? yield* Queue.take(queue) : { ...pending, flush: true };
  }
});
