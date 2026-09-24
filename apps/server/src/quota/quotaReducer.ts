// @effect-diagnostics globalDate:off - pure predicates; `now` is an injectable parameter.
/**
 * Pure reducer turning provider runtime events into the quota read model.
 *
 * Kept separate from the service so the rules that matter — which driver's
 * payload gets which normalizer, when a limit clears, what a stale snapshot
 * looks like — are testable without an Effect runtime or a live provider.
 *
 * @module quota/quotaReducer
 */
import {
  isQuotaSnapshotStale,
  QUOTA_SNAPSHOT_STALE_AFTER_MS,
  type AccountQuotaSnapshot,
  type QuotaErrorCode,
} from "@t3tools/contracts/quota";
import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderRuntimeEvent,
} from "@t3tools/contracts";

import {
  mergeQuotaSnapshots,
  normalizeAntigravityRateLimits,
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
  normalizeUpstreamUsageLimits,
} from "./normalizeRateLimits.ts";

/** Quota keyed by provider instance. Absent means "nothing published yet". */
export type QuotaState = ReadonlyMap<ProviderInstanceId, AccountQuotaSnapshot>;

export const emptyQuotaState: QuotaState = new Map();

/**
 * Pick the normalizer for a driver.
 *
 * Unknown drivers return `undefined` rather than falling back to a "generic"
 * parse. A driver this build has never seen — a fork's, a newer release's —
 * has an unknown payload shape, and guessing at it produces a confident wrong
 * number, which is the one outcome this whole module is built to avoid.
 */
function normalizerFor(driverKind: string) {
  switch (driverKind) {
    case "codex":
      return normalizeCodexRateLimits;
    case "claudeAgent":
      return normalizeClaudeRateLimits;
    case "antigravity":
      return normalizeAntigravityRateLimits;
    default:
      return undefined;
  }
}

export interface QuotaEventInput {
  readonly providerInstanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind | string;
  readonly event: ProviderRuntimeEvent;
  readonly observedAt: string;
}

/**
 * Apply one runtime event.
 *
 * Returns the same state object when nothing changed, so callers can skip a
 * publish on identity. Most events are not quota events, and re-rendering the
 * sidebar on every assistant delta would be a real cost.
 */
export function applyQuotaEvent(state: QuotaState, input: QuotaEventInput): QuotaState {
  if (input.event.type !== "account.rate-limits.updated") return state;

  const normalize = normalizerFor(input.driverKind);
  if (!normalize) return state;

  const previous = state.get(input.providerInstanceId);
  if (previous) {
    const prevTime = Date.parse(previous.observedAt);
    const nextTime = Date.parse(input.observedAt);
    if (!Number.isNaN(prevTime) && !Number.isNaN(nextTime) && nextTime < prevTime) {
      if (input.driverKind !== "codex") {
        return state;
      }
    }
  }

  // Adapters that already emit upstream's normalized shape need no
  // provider-specific parsing; only an older emitter falls through.
  const normalizerInput = {
    providerInstanceId: input.providerInstanceId,
    payload: input.event.payload,
    observedAt: input.observedAt,
  };
  const snapshot = normalize(normalizerInput) ?? normalizeUpstreamUsageLimits(normalizerInput);
  if (!snapshot) {
    // Claude and Antigravity probes are point-in-time reads. If one explicitly
    // publishes no usable quota, retaining its old snapshot would present stale
    // numbers as current telemetry. Codex is different: its events are sparse,
    // so an empty update is not evidence that previously observed windows
    // disappeared.
    if (input.driverKind === "codex" || !state.has(input.providerInstanceId)) return state;
    const next = new Map(state);
    next.delete(input.providerInstanceId);
    return next;
  }

  // Codex can publish one rate-limit window at a time, so preserve its
  // documented sparse-update semantics. Claude and Antigravity probes are
  // point-in-time reads: carrying a missing pool/window forward makes stale
  // telemetry look freshly observed and can copy an old value onto an idle
  // account. Replace those snapshots wholesale so missing data stays unknown.
  const nextSnapshot =
    input.driverKind === "codex" ? mergeQuotaSnapshots(previous, snapshot) : snapshot;

  const next = new Map(state);
  next.set(input.providerInstanceId, nextSnapshot);
  return next;
}

/**
 * Forget an instance's quota.
 *
 * Called when an instance is removed or reconfigured. A snapshot outliving the
 * account it described is worse than no snapshot: it reads as current.
 */
export function forgetQuota(state: QuotaState, providerInstanceId: ProviderInstanceId): QuotaState {
  if (!state.has(providerInstanceId)) return state;
  const next = new Map(state);
  next.delete(providerInstanceId);
  return next;
}

/**
 * Age at which a snapshot stops being trustworthy.
 *
 * Providers publish rate limits as a side effect of doing work, so an idle
 * account simply stops reporting. Six hours outlives the short window
 * everywhere it is currently observed, so a snapshot older than this is
 * describing a window that has since reset.
 */
export { isQuotaSnapshotStale, QUOTA_SNAPSHOT_STALE_AFTER_MS };

/**
 * Whether an instance should be treated as rate-limited right now.
 *
 * Driven by the provider's own `limitReached` signal, never by a percentage:
 * a window can report 100% and still accept work, and a limit can be reached
 * below 100% on a different axis such as credits.
 *
 * A stale snapshot never reports limited. This is the specific bug that makes
 * an account look permanently broken — you hit a limit, the window resets
 * hours later, and the UI is still refusing to let you continue because
 * nothing ever cleared the flag.
 */
export function isRateLimited(
  snapshot: AccountQuotaSnapshot | undefined,
  now: number = Date.now(),
): boolean {
  if (!snapshot?.limitReached) return false;
  if (isQuotaSnapshotStale(snapshot, now)) return false;

  // A published reset time in the past clears it too: the window has rolled
  // over even though the provider has not yet had reason to say so.
  const soonest = earliestReset(snapshot);
  if (soonest !== undefined && soonest <= now) return false;

  return true;
}

/** Earliest reset across every window, as epoch ms. */
export function earliestReset(snapshot: AccountQuotaSnapshot): number | undefined {
  let earliest: number | undefined;
  for (const group of snapshot.groups) {
    for (const window of group.windows) {
      if (!window.resetsAt) continue;
      const parsed = Date.parse(window.resetsAt);
      if (Number.isNaN(parsed)) continue;
      if (earliest === undefined || parsed < earliest) earliest = parsed;
    }
  }
  return earliest;
}

/**
 * Classify a probe or refresh failure into a non-sensitive QuotaErrorCode.
 */
export function classifyQuotaError(error: unknown): QuotaErrorCode {
  if (error === null || error === undefined) return "unavailable";

  if (typeof error === "object") {
    const err = error as Record<string, unknown>;
    const status = err["status"] ?? err["statusCode"] ?? err["httpStatus"] ?? err["code"];
    if (
      status === 429 ||
      status === "429" ||
      status === "rate_limited" ||
      err["_tag"] === "RateLimitExceeded"
    ) {
      return "rate_limited";
    }
    if (
      status === 401 ||
      status === "401" ||
      status === "unauthorized" ||
      err["_tag"] === "Unauthorized"
    ) {
      return "unauthorized";
    }
    if (
      status === 403 ||
      status === "403" ||
      status === "forbidden" ||
      err["_tag"] === "Forbidden"
    ) {
      return "forbidden";
    }
    if (
      status === 408 ||
      status === 504 ||
      err["_tag"] === "TimeoutException" ||
      err["name"] === "TimeoutError" ||
      (typeof err["message"] === "string" && /timed?\s*out/i.test(err["message"]))
    ) {
      return "timeout";
    }
    if (
      err["_tag"] === "CodexAppServerSpawnError" ||
      err["_tag"] === "CodexAppServerProcessExitedError" ||
      err["_tag"] === "ProcessError"
    ) {
      return "process_error";
    }
    if (
      err["name"] === "SyntaxError" ||
      (typeof err["message"] === "string" && /JSON/i.test(err["message"]))
    ) {
      return "parse_error";
    }
    if (
      err["_tag"] === "NetworkError" ||
      (typeof err["message"] === "string" && /ECONNREFUSED|ENOTFOUND|network/i.test(err["message"]))
    ) {
      return "network_error";
    }
  }

  const message = String(error);
  if (/429|rate\s*limit|too\s*many\s*requests/i.test(message)) return "rate_limited";
  if (/401|unauthorized/i.test(message)) return "unauthorized";
  if (/403|forbidden/i.test(message)) return "forbidden";
  if (/timed?\s*out/i.test(message)) return "timeout";
  if (/JSON|SyntaxError/i.test(message)) return "parse_error";
  if (/process|spawn|exit/i.test(message)) return "process_error";
  if (/network|econnrefused|enotfound/i.test(message)) return "network_error";

  return "unavailable";
}
