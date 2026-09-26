// @effect-diagnostics globalDate:off - staleness accepts an injected clock for deterministic callers.

/**
 * Subscription quota contracts — the rolling usage windows a provider
 * publishes for the account behind a provider instance.
 *
 * This is deliberately NOT the same thing as the Usage page, which reports
 * API-equivalent token *cost* reconstructed from local session history. This
 * module models the provider's own subscription limits: "83% of the weekly
 * window, resets Tuesday".
 *
 * Fork-local (OmniCode). Kept in its own file so it never conflicts with
 * upstream edits to `orchestration.ts` / `providerRuntime.ts`. See `OMNI.md`.
 *
 * The honesty rule this module exists to enforce: a window is reported only
 * when the provider actually published it. Anything unknown is absent, never
 * zero and never extrapolated — the UI renders absence as "not exposed".
 *
 * @module quota
 */
import * as Schema from "effect/Schema";

import { IsoDateTime, TrimmedNonEmptyString } from "./baseSchemas.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

/**
 * Which rolling window a figure belongs to.
 *
 * Providers name these inconsistently (Codex calls them primary/secondary,
 * Claude publishes duration-tagged windows), so they are normalized by
 * duration where the provider supplies one:
 *
 *  - `short` — the hours-scale window. Codex `primary`, ~300 minutes.
 *  - `long` — the days-scale window. Codex `secondary`, ~10080 minutes.
 *  - `unknown` — published without a duration we can classify. Still shown,
 *    labelled by whatever the provider called it, never guessed into a bucket.
 */
export const QuotaWindowKind = Schema.Literals(["short", "long", "unknown"]);
export type QuotaWindowKind = typeof QuotaWindowKind.Type;

/**
 * How a figure was obtained. Rendered as confidence in the UI, so a value
 * scraped from an error message never looks as authoritative as one the
 * provider pushed.
 */
export const QuotaSource = Schema.Literals([
  /** Provider pushed a structured rate-limit update. Authoritative. */
  "provider-event",
  /** Read from a provider-owned state file on disk. Authoritative. */
  "state-file",
  /** Inferred from a limit-reached signal. Directional only. */
  "limit-signal",
  /** Structured quota summary from Antigravity direct probe or bridge. */
  "antigravity-quota-summary",
  /** Conservative per-model fallback when pooled data is unavailable. */
  "antigravity-model-fallback",
  /** Active status probe from Codex app-server. Authoritative. */
  "codex-app-server",
  /** Cold-start quota recovery from Codex session transcripts. Directional. */
  "codex-transcript",
]);
export type QuotaSource = typeof QuotaSource.Type;

/** Non-sensitive classification of a failed probe or refresh attempt. */
export const QuotaErrorCode = Schema.Literals([
  "rate_limited",
  "unauthorized",
  "forbidden",
  "timeout",
  "unavailable",
  "network_error",
  "process_error",
  "parse_error",
]);
export type QuotaErrorCode = typeof QuotaErrorCode.Type;

/** Percent used within a window: 0–100, clamped by the normalizer. */
export const QuotaUsedPercent = Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

/**
 * One rolling window.
 *
 * `resetsAt` is absent when the provider did not publish a reset time. That is
 * common in sparse rolling updates and must not be rendered as "resets now".
 */
export const QuotaWindow = Schema.Struct({
  /** Stable semantic identifier for sparse updates and deduplication. */
  id: Schema.optional(TrimmedNonEmptyString),
  kind: QuotaWindowKind,
  /** Provider's own label where it has one, e.g. "Weekly limit". */
  label: Schema.optional(TrimmedNonEmptyString),
  usedPercent: QuotaUsedPercent,
  resetsAt: Schema.optional(IsoDateTime),
  windowDurationMins: Schema.optional(Schema.Number.check(Schema.isGreaterThan(0))),
});
export type QuotaWindow = typeof QuotaWindow.Type;

/**
 * An independent pool of quota within one account.
 *
 * Most providers have exactly one. Antigravity does not: a single agy account
 * carries at least two independent pools (Gemini models in one; Claude and GPT
 * models in another), each with its own windows and reset timers. Modelling
 * groups from the start is why that provider does not need a special case
 * later.
 */
export const QuotaGroup = Schema.Struct({
  /** Stable within an account. `"default"` for single-pool providers. */
  key: TrimmedNonEmptyString,
  displayName: TrimmedNonEmptyString,
  windows: Schema.Array(QuotaWindow),
});
export type QuotaGroup = typeof QuotaGroup.Type;

/** Reset credits balance where available (e.g. Codex reset credits). */
export const QuotaResetCredits = Schema.Struct({
  availableCount: Schema.Number,
  nextExpiresAt: Schema.optional(IsoDateTime),
});
export type QuotaResetCredits = typeof QuotaResetCredits.Type;

/**
 * Everything known about one provider instance's subscription quota.
 *
 * An instance that has published nothing yet is represented by absence — there
 * is no "empty" snapshot, because a zeroed row reads as "0% used" to a person
 * glancing at a sidebar, which is the exact lie this module refuses to tell.
 */
export const AccountQuotaSnapshot = Schema.Struct({
  providerInstanceId: ProviderInstanceId,
  groups: Schema.Array(QuotaGroup),
  source: QuotaSource,
  observedAt: IsoDateTime,
  /** Provider's plan name where published, e.g. "pro". Display only. */
  planType: Schema.optional(TrimmedNonEmptyString),
  /**
   * The account this instance is signed in as, where the provider tells us.
   *
   * Present so the UI can collapse instances that turn out to share one
   * account instead of repeating a single account's usage once per instance —
   * which reads as several accounts all coincidentally at the same percentage.
   */
  accountLabel: Schema.optional(TrimmedNonEmptyString),
  /**
   * Set when the provider says a limit is currently reached, carrying its own
   * reason string. Presence — not a percentage — is what drives the
   * rate-limited state, because a window can report 100% and still accept work,
   * and a limit can be reached below 100% on a different axis (credits).
   */
  limitReached: Schema.optional(TrimmedNonEmptyString),
  /** Last probe or refresh attempt timestamp. */
  lastAttemptAt: Schema.optional(IsoDateTime),
  /** Last successful probe or event observation timestamp. */
  lastSuccessfulAt: Schema.optional(IsoDateTime),
  /** Non-sensitive error classification if the most recent attempt failed. */
  errorCode: Schema.optional(TrimmedNonEmptyString),
  /** Reset credits balance where available. */
  resetCredits: Schema.optional(QuotaResetCredits),
  /** When a probe or request was throttled, when to retry. */
  retryAfterMs: Schema.optional(Schema.Number),
  /** Timestamp until which the provider is throttled or backing off. */
  retryAt: Schema.optional(IsoDateTime),
});
export type AccountQuotaSnapshot = typeof AccountQuotaSnapshot.Type;

/** Bumped when the wire representation of {@link QuotaSummary} changes incompatibly. */
export const QUOTA_CONTRACT_VERSION = 1 as const;

/**
 * Server-wide quota read model.
 *
 * Maps are encoded as arrays on the wire. `providerInstanceId` remains part of
 * every snapshot, so clients can merge several environments without ever
 * collapsing two accounts that use the same driver.
 */
export const QuotaSummary = Schema.Struct({
  contractVersion: Schema.Number,
  snapshots: Schema.Array(AccountQuotaSnapshot),
});
export type QuotaSummary = typeof QuotaSummary.Type;

/** Minutes in the window each provider treats as its hours-scale limit. */
export const SHORT_WINDOW_MAX_MINS = 24 * 60;

/**
 * Classify a window by its published duration.
 *
 * Anything without a duration stays `unknown` rather than being assigned to a
 * bucket by position, because provider ordering is not a documented guarantee.
 */
export function quotaWindowKindFromDuration(
  windowDurationMins: number | null | undefined,
): QuotaWindowKind {
  if (typeof windowDurationMins !== "number" || !Number.isFinite(windowDurationMins)) {
    return "unknown";
  }
  if (windowDurationMins <= 0) return "unknown";
  return windowDurationMins <= SHORT_WINDOW_MAX_MINS ? "short" : "long";
}

/**
 * The window a person most wants to see first: whichever is closest to
 * exhausted, ties broken toward the longer window because it is the one that
 * takes days rather than hours to recover.
 */
export function primaryQuotaWindow(windows: ReadonlyArray<QuotaWindow>): QuotaWindow | undefined {
  let best: QuotaWindow | undefined;
  for (const window of windows) {
    if (!best) {
      best = window;
      continue;
    }
    if (window.usedPercent > best.usedPercent) {
      best = window;
      continue;
    }
    if (window.usedPercent === best.usedPercent && window.kind === "long") {
      best = window;
    }
  }
  return best;
}

/** Six hours outlives the short subscription window currently exposed by providers. */
export const QUOTA_SNAPSHOT_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

/** Invalid timestamps are stale rather than accidentally current. */
export function isQuotaSnapshotStale(
  snapshot: AccountQuotaSnapshot,
  now: number = Date.now(),
): boolean {
  const observed = Date.parse(snapshot.observedAt);
  if (Number.isNaN(observed)) return true;
  return now - observed > QUOTA_SNAPSHOT_STALE_AFTER_MS;
}
