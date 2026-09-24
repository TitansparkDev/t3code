/**
 * Live, instance-keyed subscription quota state.
 *
 * Runtime ingestion feeds canonical provider events into this service. The
 * service publishes only when the pure reducer returns a new state object, so
 * assistant deltas and other unrelated runtime traffic never fan out into
 * sidebar renders.
 *
 * @module quota/QuotaService
 */
import type { ProviderInstanceId, ProviderRuntimeEvent } from "@t3tools/contracts";
import {
  type AccountQuotaSnapshot,
  QUOTA_CONTRACT_VERSION,
  type QuotaErrorCode,
  type QuotaSummary,
} from "@t3tools/contracts/quota";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import {
  applyQuotaEvent,
  classifyQuotaError,
  emptyQuotaState,
  type QuotaState,
} from "./quotaReducer.ts";

export interface QuotaIngestOptions {
  readonly probeStartRevision?: number;
}

export class QuotaService extends Context.Service<
  QuotaService,
  {
    readonly readSummary: Effect.Effect<QuotaSummary>;
    readonly ingest: (
      event: ProviderRuntimeEvent,
      options?: QuotaIngestOptions | unknown,
    ) => Effect.Effect<void>;
    readonly seedSnapshot: (snapshot: AccountQuotaSnapshot) => Effect.Effect<void>;
    readonly getRevision: (instanceId: ProviderInstanceId) => Effect.Effect<number>;
    readonly recordAttempt: (
      instanceId: ProviderInstanceId,
      attemptedAt?: string,
    ) => Effect.Effect<number>;
    readonly recordFailure: (
      instanceId: ProviderInstanceId,
      error: QuotaErrorCode | { readonly code: QuotaErrorCode; readonly attemptedAt?: string },
    ) => Effect.Effect<void>;
    readonly coordinateRefresh: <E, R = never>(
      instanceId: ProviderInstanceId,
      probe: Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>, E, R>,
      options?: { readonly retryAfterMs?: number },
    ) => Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>, never, R>;
    readonly changes: Stream.Stream<QuotaSummary>;
  }
>()("t3/quota/QuotaService") {}

function summaryFromState(state: QuotaState): QuotaSummary {
  return {
    contractVersion: QUOTA_CONTRACT_VERSION,
    snapshots: [...state.values()].sort((left, right) =>
      String(left.providerInstanceId).localeCompare(String(right.providerInstanceId)),
    ),
  };
}

export const make = Effect.gen(function* () {
  const state = yield* SubscriptionRef.make<QuotaState>(emptyQuotaState);
  const revisions = yield* Ref.make<Map<ProviderInstanceId, number>>(new Map());
  const inflightProbes = new Map<
    ProviderInstanceId,
    Deferred.Deferred<ReadonlyArray<ProviderRuntimeEvent>, never>
  >();
  const backoffs = new Map<ProviderInstanceId, number>();

  const getRevision = (instanceId: ProviderInstanceId) =>
    Ref.get(revisions).pipe(Effect.map((revs) => revs.get(instanceId) ?? 0));

  const recordAttempt = Effect.fn("QuotaService.recordAttempt")(function* (
    instanceId: ProviderInstanceId,
    attemptedAt?: string,
  ) {
    const at = attemptedAt ?? DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(state, (current) => {
      const existing = current.get(instanceId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(instanceId, { ...existing, lastAttemptAt: at });
      return next;
    });
    const revs = yield* Ref.get(revisions);
    return revs.get(instanceId) ?? 0;
  });

  const recordFailure = Effect.fn("QuotaService.recordFailure")(function* (
    instanceId: ProviderInstanceId,
    error: QuotaErrorCode | { readonly code: QuotaErrorCode; readonly attemptedAt?: string },
  ) {
    const code = typeof error === "string" ? error : error.code;
    const attemptedAt = typeof error === "string" ? undefined : error.attemptedAt;
    const at = attemptedAt ?? DateTime.formatIso(yield* DateTime.now);
    yield* SubscriptionRef.update(state, (current) => {
      const existing = current.get(instanceId);
      if (!existing) return current;
      const next = new Map(current);
      next.set(instanceId, {
        ...existing,
        lastAttemptAt: at,
        errorCode: code,
      });
      return next;
    });
    yield* Ref.update(revisions, (revs) => {
      const next = new Map(revs);
      next.set(instanceId, (next.get(instanceId) ?? 0) + 1);
      return next;
    });
  });

  const ingest = Effect.fn("QuotaService.ingest")(function* (
    event: ProviderRuntimeEvent,
    options?: QuotaIngestOptions | unknown,
  ) {
    const providerInstanceId = event.providerInstanceId;
    if (providerInstanceId === undefined) return;

    const probeStartRevision =
      typeof options === "object" && options !== null && "probeStartRevision" in options
        ? (options as QuotaIngestOptions).probeStartRevision
        : undefined;

    if (probeStartRevision !== undefined) {
      const revs = yield* Ref.get(revisions);
      const currentRev = revs.get(providerInstanceId) ?? 0;
      if (currentRev > probeStartRevision) {
        // A newer event was already published for this account while this probe ran.
        return;
      }
    }

    yield* SubscriptionRef.updateSome(state, (current) => {
      const existing = current.get(providerInstanceId);
      // A manual refresh is ingested synchronously by the RPC and also
      // arrives a moment later through ProviderRuntimeIngestion. Ignore that
      // same event timestamp on the second path instead of publishing the
      // same snapshot twice.
      if (existing && existing.observedAt === event.createdAt) {
        return Option.none();
      }
      const next = applyQuotaEvent(current, {
        providerInstanceId,
        driverKind: event.provider,
        event,
        observedAt: event.createdAt,
      });
      if (next === current) return Option.none();

      const updated = next.get(providerInstanceId);
      if (updated) {
        const { errorCode: _discard, ...rest } = updated;
        const enriched: AccountQuotaSnapshot = {
          ...rest,
          lastSuccessfulAt: event.createdAt,
          lastAttemptAt: event.createdAt,
        };
        const nextWithEnriched = new Map(next);
        nextWithEnriched.set(providerInstanceId, enriched);
        return Option.some(nextWithEnriched);
      }

      return Option.some(next);
    });

    yield* Ref.update(revisions, (revs) => {
      const next = new Map(revs);
      next.set(providerInstanceId, (next.get(providerInstanceId) ?? 0) + 1);
      return next;
    });
  });

  const seedSnapshot = Effect.fn("QuotaService.seedSnapshot")(function* (
    snapshot: AccountQuotaSnapshot,
  ) {
    yield* SubscriptionRef.updateSome(state, (current) => {
      const existing = current.get(snapshot.providerInstanceId);
      if (existing && Date.parse(existing.observedAt) >= Date.parse(snapshot.observedAt)) {
        return Option.none();
      }
      const next = new Map(current);
      next.set(snapshot.providerInstanceId, snapshot);
      return Option.some(next);
    });
    yield* Ref.update(revisions, (revs) => {
      const next = new Map(revs);
      next.set(snapshot.providerInstanceId, (next.get(snapshot.providerInstanceId) ?? 0) + 1);
      return next;
    });
  });

  const coordinateRefresh = <E, R = never>(
    instanceId: ProviderInstanceId,
    probe: Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>, E, R>,
    options?: { readonly retryAfterMs?: number },
  ): Effect.Effect<ReadonlyArray<ProviderRuntimeEvent>, never, R> =>
    Effect.gen(function* () {
      const now = yield* Clock.currentTimeMillis;
      const backoffUntil = backoffs.get(instanceId);
      if (backoffUntil !== undefined && now < backoffUntil) {
        return [] as ReadonlyArray<ProviderRuntimeEvent>;
      }

      const existing = inflightProbes.get(instanceId);
      if (existing) {
        return yield* Deferred.await(existing);
      }
      const deferred = yield* Deferred.make<ReadonlyArray<ProviderRuntimeEvent>, never>();
      inflightProbes.set(instanceId, deferred);

      return yield* Effect.gen(function* () {
        const startRev = yield* recordAttempt(instanceId);

        const probeExit = yield* probe.pipe(
          Effect.tapError((cause) =>
            Effect.logWarning("quota.coordinateRefresh.probe-failed", { instanceId, cause }),
          ),
          Effect.exit,
        );

        if (Exit.isFailure(probeExit)) {
          const err = Cause.squash(probeExit.cause);
          const code = classifyQuotaError(err);
          if (code === "rate_limited") {
            const backoffMs = options?.retryAfterMs ?? 30_000;
            backoffs.set(instanceId, now + backoffMs);
          }
          const currentRev = yield* getRevision(instanceId);
          if (currentRev <= startRev) {
            yield* recordFailure(instanceId, { code });
          }
          yield* Deferred.succeed(deferred, []);
          return [] as ReadonlyArray<ProviderRuntimeEvent>;
        }

        const events = probeExit.value;
        const currentRev = yield* getRevision(instanceId);
        if (currentRev > startRev) {
          // Stale probe! A newer event arrived while probe was running.
          yield* Deferred.succeed(deferred, []);
          return [] as ReadonlyArray<ProviderRuntimeEvent>;
        }

        for (const event of events) {
          yield* ingest(event, { probeStartRevision: startRev });
        }

        if (events.length > 0) {
          backoffs.delete(instanceId);
        }

        yield* Deferred.succeed(deferred, events);
        return events;
      }).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            inflightProbes.delete(instanceId);
          }),
        ),
      );
    });

  return QuotaService.of({
    readSummary: SubscriptionRef.get(state).pipe(Effect.map(summaryFromState)),
    ingest,
    seedSnapshot,
    getRevision,
    recordAttempt,
    recordFailure,
    coordinateRefresh,
    changes: SubscriptionRef.changes(state).pipe(Stream.map(summaryFromState)),
  });
});

export const layer = Layer.effect(QuotaService, make);

/** Empty service for tests whose RPC surface needs the dependency but not quota events. */
export const layerTest = Layer.succeed(
  QuotaService,
  QuotaService.of({
    readSummary: Effect.succeed({
      contractVersion: QUOTA_CONTRACT_VERSION,
      snapshots: [],
    }),
    ingest: () => Effect.void,
    seedSnapshot: () => Effect.void,
    getRevision: () => Effect.succeed(0),
    recordAttempt: () => Effect.succeed(0),
    recordFailure: () => Effect.void,
    coordinateRefresh: () => Effect.succeed([]),
    changes: Stream.succeed({
      contractVersion: QUOTA_CONTRACT_VERSION,
      snapshots: [],
    }),
  }),
);
