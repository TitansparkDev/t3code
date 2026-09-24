// @effect-diagnostics globalDate:off - pure scheduling predicates; `now` is injectable.
/**
 * Background loop periodically probing provider instances for quota.
 *
 * Keeps idle accounts from going stale. When the user isn't generating,
 * turns never run, so runtime-ingested quota goes un-updated until the
 * next prompt. This loop runs every fifteen minutes, looks for instances
 * whose snapshot has aged past the configured threshold, and triggers a
 * refresh probe through ProviderService.
 *
 * @module quota/QuotaRefreshLoop
 */
import type { ProviderInstanceId } from "@t3tools/contracts";
import type { QuotaSummary } from "@t3tools/contracts/quota";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";

import { earliestReset } from "./quotaReducer.ts";

/** Probe interval: sweep every fifteen minutes. */
export const QUOTA_REFRESH_INTERVAL = "15 minutes";

/** Refresh any snapshot older than ten minutes. */
export const QUOTA_REFRESH_MINIMUM_AGE_MS = 10 * 60 * 1000;

export interface QuotaRefreshLoopDependencies {
  readonly listInstanceIds: Effect.Effect<ReadonlyArray<ProviderInstanceId>>;
  readonly readSummary: Effect.Effect<QuotaSummary>;
  readonly refreshQuota: (instanceId: ProviderInstanceId) => Effect.Effect<unknown>;
}

export interface QuotaRefreshLoopOptions {
  readonly minimumAgeMs?: number;
}

/**
 * Instances due for a probe: everything with no snapshot, plus everything whose
 * snapshot is older than `minimumAgeMs`, or whose reset time rolled over since
 * the last snapshot was observed.
 *
 * An unparseable `observedAt` counts as due — a snapshot we cannot date is one
 * we cannot claim is current.
 */
export function selectInstancesToRefresh(input: {
  readonly instanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly summary: QuotaSummary;
  readonly now: number;
  readonly minimumAgeMs: number;
  readonly backoffs?: ReadonlyMap<ProviderInstanceId, number> | undefined;
}): ReadonlyArray<ProviderInstanceId> {
  const snapshots = new Map(
    input.summary.snapshots.map((snapshot) => [snapshot.providerInstanceId, snapshot]),
  );
  return input.instanceIds.filter((instanceId) => {
    const backoffUntil = input.backoffs?.get(instanceId);
    if (backoffUntil !== undefined && input.now < backoffUntil) {
      return false;
    }
    const snapshot = snapshots.get(instanceId);
    if (snapshot === undefined) return true;
    const parsedObserved = Date.parse(snapshot.observedAt);
    if (Number.isNaN(parsedObserved)) return true;

    // Reset boundary check: if a reset time has passed since observedAt,
    // the window rolled over and needs fresh telemetry.
    const reset = earliestReset(snapshot);
    if (reset !== undefined && reset <= input.now && parsedObserved < reset) {
      return true;
    }

    return input.now - parsedObserved >= input.minimumAgeMs;
  });
}

/** One sweep across the registered instances. Exposed for testing. */
export const makeQuotaRefreshSweep = (
  dependencies: QuotaRefreshLoopDependencies,
  options?: QuotaRefreshLoopOptions & {
    readonly backoffsRef?: Ref.Ref<Map<ProviderInstanceId, number>>;
  },
) =>
  Effect.gen(function* () {
    const minimumAgeMs = Math.max(0, options?.minimumAgeMs ?? QUOTA_REFRESH_MINIMUM_AGE_MS);
    const instanceIds = yield* dependencies.listInstanceIds;
    if (instanceIds.length === 0) return;
    const summary = yield* dependencies.readSummary;
    const now = yield* Clock.currentTimeMillis;
    const backoffs = options?.backoffsRef ? yield* Ref.get(options.backoffsRef) : undefined;
    const due = selectInstancesToRefresh({ instanceIds, summary, now, minimumAgeMs, backoffs });

    for (const instanceId of due) {
      yield* dependencies.refreshQuota(instanceId).pipe(
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            yield* Effect.logWarning("quota.refresh-loop.instance-failed", { instanceId, cause });
            if (options?.backoffsRef) {
              yield* Ref.update(options.backoffsRef, (map) => {
                const next = new Map(map);
                next.set(instanceId, now + 60_000);
                return next;
              });
            }
          }),
        ),
      );
    }
  });

/** The sweep on a schedule. Fork this; it never completes. */
export const makeQuotaRefreshLoop = (
  dependencies: QuotaRefreshLoopDependencies,
  options?: QuotaRefreshLoopOptions,
) =>
  Effect.gen(function* () {
    const backoffsRef = yield* Ref.make<Map<ProviderInstanceId, number>>(new Map());
    const sweep = makeQuotaRefreshSweep(dependencies, { ...options, backoffsRef });
    return yield* sweep.pipe(
      Effect.repeat(Schedule.spaced(QUOTA_REFRESH_INTERVAL)),
      Effect.annotateLogs({ loop: "QuotaRefreshLoop" }),
    );
  });
