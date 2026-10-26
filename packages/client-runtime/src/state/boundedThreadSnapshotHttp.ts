import type { ThreadId } from "@t3tools/contracts";
import { boundedSnapshotProjection } from "@t3tools/shared/orchestrationV2BoundedSnapshot";
import * as Cause from "effect/Cause";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { PreparedConnection } from "../connection/model.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import {
  executeAuthenticatedEnvironmentHttpRequest,
  withOrchestrationProtocolHeader,
} from "./environmentHttpAuth.ts";
import * as ThreadSnapshotLoader from "./threadSnapshotHttp.ts";
import {
  isThreadOpenPerformanceEnabled,
  markThreadOpenStage,
  threadOpenTraceKey,
} from "./threadOpenPerformance.ts";

const DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS = 6_000;

const markStage = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  key: string,
  stage: "http-response" | "snapshot-decode",
) =>
  isThreadOpenPerformanceEnabled()
    ? effect.pipe(Effect.tap(() => Effect.sync(() => markThreadOpenStage(key, stage))))
    : effect;

export const fetchEnvironmentBoundedThreadSnapshot = Effect.fn(
  "clientRuntime.state.fetchEnvironmentBoundedThreadSnapshot",
)(function* (input: {
  readonly prepared: PreparedConnection;
  readonly threadId: ThreadId;
  readonly signer: Option.Option<ManagedRelay.ManagedRelayDpopSigner["Service"]>;
  readonly remoteAuthorization?: Option.Option<
    RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization["Service"]
  >;
  readonly timeoutMs?: number;
}) {
  const endpoint = {
    params: { threadId: input.threadId },
    query: { compactTurnItems: "1", dedupeBodies: "1", compactIds: "1" },
  };
  const key = threadOpenTraceKey(input.prepared.environmentId, input.threadId);
  return yield* executeAuthenticatedEnvironmentHttpRequest({
    ...input,
    group: "orchestration",
    method: "GET",
    url: (urls) => urls.threadBoundedSnapshot(endpoint),
    timeoutMs: input.timeoutMs ?? DEFAULT_BOUNDED_THREAD_SNAPSHOT_TIMEOUT_MS,
    request: ({ client, headers }) =>
      client.threadBoundedSnapshot({
        ...endpoint,
        headers: withOrchestrationProtocolHeader(headers),
      }),
  }).pipe(
    (effect) => markStage(effect, key, "http-response"),
    Effect.map(({ turnItemsOmitLocalVisible, ...snapshot }) => ({
      ...snapshot,
      projection: boundedSnapshotProjection({ ...snapshot, turnItemsOmitLocalVisible }),
    })),
    (effect) => markStage(effect, key, "snapshot-decode"),
  );
});

type InFlightThreadLoad = {
  readonly prepared: PreparedConnection;
  readonly result: Deferred.Deferred<ThreadSnapshotLoader.ThreadSnapshotLoadResult>;
};

/**
 * Concurrent opens of one thread on one connection generation share a single HTTP load. The load
 * runs detached so a navigation that is interrupted stops waiting without cancelling the result
 * other waiters may still need. Its own deadlines still bound it. A different `PreparedConnection`
 * (reconnect, new credentials) never joins an older load.
 */
const inFlightThreadLoads = new Map<string, InFlightThreadLoad>();

const loadCoalesced = (
  prepared: PreparedConnection,
  threadId: ThreadId,
  load: (
    prepared: PreparedConnection,
    threadId: ThreadId,
  ) => Effect.Effect<ThreadSnapshotLoader.ThreadSnapshotLoadResult>,
): Effect.Effect<ThreadSnapshotLoader.ThreadSnapshotLoadResult> => {
  const key = `${prepared.environmentId}\u0000${threadId}`;
  return Effect.suspend(() => {
    const existing = inFlightThreadLoads.get(key);
    if (existing !== undefined && existing.prepared === prepared) {
      return Deferred.await(existing.result);
    }
    return Effect.gen(function* () {
      const result = yield* Deferred.make<ThreadSnapshotLoader.ThreadSnapshotLoadResult>();
      yield* Effect.uninterruptible(
        Effect.gen(function* () {
          inFlightThreadLoads.set(key, { prepared, result });
          yield* load(prepared, threadId).pipe(
            Effect.interruptible,
            Effect.onExit((exit) =>
              Effect.andThen(
                Effect.sync(() => {
                  if (inFlightThreadLoads.get(key)?.result === result) {
                    inFlightThreadLoads.delete(key);
                  }
                }),
                Deferred.done(result, exit),
              ),
            ),
            Effect.forkDetach,
          );
        }),
      );
      return yield* Deferred.await(result);
    });
  });
};

/**
 * Older servers that lack the bounded route (plain/generic 404) fall back to
 * the existing full HTTP thread snapshot. Structured
 * EnvironmentResourceNotFoundError from either endpoint still means missing.
 */
export const layer: Layer.Layer<
  ThreadSnapshotLoader.ThreadSnapshotLoader,
  never,
  HttpClient.HttpClient
> = Layer.effect(
  ThreadSnapshotLoader.ThreadSnapshotLoader,
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
    const remoteAuthorization = yield* Effect.serviceOption(
      RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
    );
    const loadUncoalesced = Effect.fn("ThreadSnapshotLoader.load")(function (
      prepared: PreparedConnection,
      threadId: ThreadId,
    ) {
      const loadFullFallback = ThreadSnapshotLoader.fetchEnvironmentThreadSnapshot({
        prepared,
        threadId,
        signer,
        remoteAuthorization,
      }).pipe(
        Effect.map((snapshot): ThreadSnapshotLoader.ThreadSnapshotLoadResult => ({
          _tag: "present",
          snapshot,
        })),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchTags({
          EnvironmentResourceNotFoundError: () =>
            Effect.logDebug(
              "Full thread snapshot not found over HTTP after bounded fallback; treating the thread as deleted.",
            ).pipe(
              Effect.annotateLogs({ threadId }),
              Effect.as({
                _tag: "missing",
              } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
            ),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Could not load the full thread snapshot over HTTP after bounded fallback; using the socket snapshot instead.",
          ).pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            Effect.as({
              _tag: "unavailable",
            } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
          ),
        ),
      );

      return fetchEnvironmentBoundedThreadSnapshot({
        prepared,
        threadId,
        signer,
        remoteAuthorization,
      }).pipe(
        Effect.map((bounded): ThreadSnapshotLoader.ThreadSnapshotLoadResult => ({
          _tag: "present",
          snapshot: {
            snapshotSequence: bounded.snapshotSequence,
            projection: bounded.projection,
            latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
          },
          history: {
            historyCursor: bounded.historyCursor,
            hasMoreHistory: bounded.hasMoreHistory,
            latestLocalTurnOrdinal: bounded.latestLocalTurnOrdinal,
          },
        })),
        Effect.provideService(HttpClient.HttpClient, httpClient),
        Effect.catchTags({
          EnvironmentResourceNotFoundError: () =>
            Effect.logDebug(
              "Bounded thread snapshot not found over HTTP; treating the thread as deleted.",
            ).pipe(
              Effect.annotateLogs({ threadId }),
              Effect.as({
                _tag: "missing",
              } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
            ),
          RemoteEnvironmentAuthInvalidJsonError: (error) =>
            Effect.logDebug(
              "Bounded thread snapshot returned an invalid response; trying the full HTTP thread snapshot for an older server.",
            ).pipe(
              Effect.annotateLogs({ threadId, cause: error.message }),
              Effect.andThen(loadFullFallback),
            ),
          RemoteEnvironmentAuthUndeclaredStatusError: (error) =>
            error.status === 404
              ? Effect.logDebug(
                  "Bounded thread snapshot route was not found; trying the full HTTP thread snapshot for an older server.",
                ).pipe(Effect.annotateLogs({ threadId }), Effect.andThen(loadFullFallback))
              : Effect.fail(error),
        }),
        Effect.catchCause((cause) =>
          Effect.logWarning(
            "Could not load the bounded thread snapshot over HTTP; using the socket snapshot instead.",
          ).pipe(
            Effect.annotateLogs({ threadId, cause: Cause.pretty(cause) }),
            Effect.as({
              _tag: "unavailable",
            } satisfies ThreadSnapshotLoader.ThreadSnapshotLoadResult),
          ),
        ),
      );
    });
    return ThreadSnapshotLoader.ThreadSnapshotLoader.of({
      // @effect-diagnostics-next-line effectFnOpportunity:off - loadUncoalesced owns the span; this only shares it.
      load: (prepared, threadId) => loadCoalesced(prepared, threadId, loadUncoalesced),
    });
  }),
);
