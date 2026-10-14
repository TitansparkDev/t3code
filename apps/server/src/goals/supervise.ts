import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

/**
 * Runs `effect` for as long as the service lives. A failure or defect is logged and the work
 * starts again after `delay`: a forked fiber that dies is not reported anywhere, and a scheduler
 * or event listener that silently ends would leave every goal stalled for good.
 */
export const superviseForever = <E>(
  name: string,
  effect: Effect.Effect<unknown, E>,
  delay: Parameters<typeof Effect.sleep>[0] = "2 seconds",
): Effect.Effect<never> =>
  effect.pipe(
    Effect.catchCause((cause) =>
      Cause.hasInterruptsOnly(cause)
        ? Effect.interrupt
        : Effect.logWarning(`goals.${name}-crashed`, { cause: Cause.pretty(cause) }),
    ),
    Effect.andThen(Effect.sleep(delay)),
    Effect.forever,
  );
