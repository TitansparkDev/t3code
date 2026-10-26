import {
  EnvironmentId,
  OrchestrationV2ShellSnapshotJson,
  OrchestrationV2ThreadDetailSnapshot,
  OrchestrationV2ThreadProjectionJson,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const ORCHESTRATION_CACHE_SCHEMA_VERSION = 3 as const;
// Older caches may hold human turns that bypassed server history budgets (upstream's 5) or predate
// `requiresSnapshot` (this fork's 5). 6 is the compact format (threadCacheEncoding.ts), so the full
// format skips to 7 and drops both kinds of 5.
export const ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION = 7 as const;

export const CachedThreadSnapshot = OrchestrationV2ThreadDetailSnapshot.mapFields((fields) => ({
  ...fields,
  projection: OrchestrationV2ThreadProjectionJson,
  requiresSnapshot: Schema.optionalKey(Schema.Literal(true)),
}));
export type CachedThreadSnapshot = typeof CachedThreadSnapshot.Type;

export const StoredOrchestrationShellSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  snapshot: OrchestrationV2ShellSnapshotJson,
});

export const StoredOrchestrationThreadSnapshot = Schema.Struct({
  schemaVersion: Schema.Literal(ORCHESTRATION_THREAD_CACHE_SCHEMA_VERSION),
  environmentId: EnvironmentId,
  threadId: ThreadId,
  snapshot: CachedThreadSnapshot,
});

export function decodeOrDiscardOrchestrationCache<A, E, R, E2, R2>(
  decode: Effect.Effect<Option.Option<A>, E, R>,
  discard: Effect.Effect<void, E2, R2>,
) {
  return decode.pipe(Effect.catch(() => discard.pipe(Effect.as(Option.none<A>()))));
}
