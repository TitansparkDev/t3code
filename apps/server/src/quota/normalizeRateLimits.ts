// @effect-diagnostics globalDate:off - pure normalizers converting wire payloads to ISO strings.
/**
 * Pure rate-limit normalizers for supported providers.
 *
 * Each normalizer accepts an unknown payload and returns an
 * `AccountQuotaSnapshot` or `undefined` if the payload carries no usable
 * rate-limit data.
 *
 * @module quota/normalizeRateLimits
 */
import {
  type AccountQuotaSnapshot,
  type QuotaGroup,
  type QuotaSource,
  type QuotaWindow,
  type QuotaWindowKind,
  quotaWindowKindFromDuration,
} from "@t3tools/contracts/quota";
import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  antigravityPayloadToSnapshot,
  parseAntigravityQuotaPayload,
} from "./antigravityQuotaParser.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readRecord(
  source: Record<string, unknown>,
  key: string,
): Record<string, unknown> | undefined {
  const value = source[key];
  return isRecord(value) ? value : undefined;
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Clamp to 0–100. Providers have been observed reporting slightly over 100 on
 * a freshly exhausted window; that is a real "you are out", not a reason to
 * discard the reading. Out-of-bounds or non-finite values are rejected.
 */
function readUsedPercent(value: unknown): number | undefined {
  const raw = readFiniteNumber(value);
  if (raw === undefined) return undefined;
  if (raw < 0 || raw > 105) return undefined;
  return Math.min(100, Math.max(0, raw));
}

/**
 * Epoch seconds to ISO.
 *
 * Codex publishes `resetsAt` in **seconds**, not milliseconds — mixing those up
 * puts every reset time in 1970 or the year 57000. Values are sanity-checked
 * against a plausible range rather than trusted, and anything outside it is
 * dropped instead of displayed.
 */
const MIN_PLAUSIBLE_EPOCH_SECONDS = 1_000_000_000; // 2001-09-09
const MAX_PLAUSIBLE_EPOCH_SECONDS = 4_102_444_800; // 2100-01-01

export function isoFromEpochSeconds(value: unknown): string | undefined {
  const seconds = readFiniteNumber(value);
  if (seconds === undefined) return undefined;
  if (seconds < MIN_PLAUSIBLE_EPOCH_SECONDS || seconds > MAX_PLAUSIBLE_EPOCH_SECONDS) {
    return undefined;
  }
  const date = new Date(seconds * 1000);
  const iso = date.toISOString();
  return Number.isNaN(date.getTime()) ? undefined : iso;
}

/**
 * Accept Unix seconds and milliseconds only when the magnitude is unambiguous;
 * reject impossible reset dates.
 */
export function isoFromEpochTimestamp(value: unknown): string | undefined {
  const num = readFiniteNumber(value);
  if (num !== undefined) {
    if (num >= MIN_PLAUSIBLE_EPOCH_SECONDS && num <= MAX_PLAUSIBLE_EPOCH_SECONDS) {
      const date = new Date(num * 1000);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    if (num >= MIN_PLAUSIBLE_EPOCH_SECONDS * 1000 && num <= MAX_PLAUSIBLE_EPOCH_SECONDS * 1000) {
      const date = new Date(num);
      return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
    }
    return undefined;
  }
  const text = readNonEmptyString(value);
  if (text === undefined) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return isoFromEpochTimestamp(Number(text));
  }
  const date = new Date(text);
  const time = date.getTime();
  if (Number.isNaN(time)) return undefined;
  if (time < MIN_PLAUSIBLE_EPOCH_SECONDS * 1000 || time > MAX_PLAUSIBLE_EPOCH_SECONDS * 1000) {
    return undefined;
  }
  return date.toISOString();
}

function isoFromProviderReset(value: unknown): string | undefined {
  return isoFromEpochTimestamp(value);
}

/**
 * One `{ usedPercent, resetsAt?, windowDurationMins? }` window.
 *
 * `usedPercent` is the only required field: a window with no percentage tells
 * us nothing, so it is dropped rather than shown at zero.
 */
function normalizeWindow(
  value: unknown,
  fallbackLabel?: string,
  fallbackDurationMins?: number,
  fallbackId?: string,
): QuotaWindow | undefined {
  if (!isRecord(value) || value["disabled"] === true) return undefined;
  const usedPercent = readUsedPercent(
    value["usedPercent"] ?? value["used_percent"] ?? value["utilization"],
  );
  if (usedPercent === undefined) return undefined;

  const windowDurationMins =
    readFiniteNumber(value["windowDurationMins"] ?? value["window_minutes"]) ??
    fallbackDurationMins;
  const rawReset =
    value["resetsAt"] ?? value["resets_at"] ?? value["resetTime"] ?? value["reset_time"];
  const resetsAt = isoFromProviderReset(rawReset);
  const label = readNonEmptyString(value["label"] ?? value["name"]) ?? fallbackLabel;
  const rawId = readNonEmptyString(value["id"] ?? value["bucketId"] ?? value["bucket_id"]);
  const id = rawId ?? fallbackId;

  return {
    kind: quotaWindowKindFromDuration(windowDurationMins),
    usedPercent,
    ...(label ? { label } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined && windowDurationMins > 0 ? { windowDurationMins } : {}),
    ...(id ? { id } : {}),
  };
}

/**
 * Upstream normalizes `account.rate-limits.updated` inside each adapter now,
 * so the payload arrives as `{ limits: { windows } }` in the shared
 * ServerProviderUsageWindow shape. Reading that directly beats re-deriving it
 * from a provider's wire format, so every normalizer tries this first and only
 * falls back to its own parsing for an older or unconverted emitter.
 */
export function normalizeUpstreamUsageLimits(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: unknown;
  readonly observedAt: string;
}): AccountQuotaSnapshot | undefined {
  if (!isRecord(input.payload)) return undefined;
  const limits = readRecord(input.payload, "limits");
  const rawWindows = limits ? limits["windows"] : undefined;
  if (!Array.isArray(rawWindows) || rawWindows.length === 0) return undefined;

  const windows: Array<QuotaWindow> = [];
  for (const entry of rawWindows) {
    if (!isRecord(entry)) continue;
    const usedPercent = readUsedPercent(entry["usedPercent"]);
    if (usedPercent === undefined) continue;
    const kind = entry["kind"];
    const label = entry["label"];
    const resetsAt = isoFromProviderReset(entry["resetsAt"]);
    const windowDurationMins = readFiniteNumber(entry["windowDurationMins"]);
    const mappedKind: QuotaWindowKind =
      kind === "session"
        ? "short"
        : kind === "weekly" || kind === "monthly"
          ? "long"
          : quotaWindowKindFromDuration(windowDurationMins);
    const windowDuration =
      windowDurationMins !== undefined && windowDurationMins > 0
        ? windowDurationMins
        : mappedKind === "short"
          ? 300
          : mappedKind === "long"
            ? 10_080
            : undefined;

    const rawId = readNonEmptyString(entry["id"]);

    windows.push({
      kind: mappedKind,
      usedPercent,
      ...(label ? { label: String(label) } : {}),
      ...(resetsAt ? { resetsAt: String(resetsAt) } : {}),
      ...(windowDuration ? { windowDurationMins: windowDuration } : {}),
      ...(rawId ? { id: rawId } : {}),
    });
  }

  if (windows.length === 0) return undefined;

  return {
    providerInstanceId: input.providerInstanceId,
    groups: [{ key: "default", displayName: "Subscription", windows }],
    source: "provider-event" satisfies QuotaSource,
    observedAt: input.observedAt,
  };
}

export function normalizeCodexRateLimits(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: unknown;
  readonly observedAt: string;
}): AccountQuotaSnapshot | undefined {
  if (!isRecord(input.payload)) return undefined;

  // Accept wrapped and unwrapped payloads:
  const payloadRecord = readRecord(input.payload, "payload") ?? input.payload;
  const outer =
    readRecord(payloadRecord, "rateLimits") ??
    readRecord(payloadRecord, "rate_limits") ??
    payloadRecord;
  const snapshot = readRecord(outer, "rateLimits") ?? readRecord(outer, "rate_limits") ?? outer;

  const windows: Array<QuotaWindow> = [];
  const primary = normalizeWindow(snapshot["primary"]);
  if (primary) windows.push(primary);
  const secondary = normalizeWindow(snapshot["secondary"]);
  if (secondary) windows.push(secondary);

  const additional =
    snapshot["additional_rate_limits"] ??
    snapshot["additionalRateLimits"] ??
    outer["additional_rate_limits"] ??
    outer["additionalRateLimits"];
  if (Array.isArray(additional)) {
    for (let index = 0; index < additional.length; index++) {
      const item = additional[index];
      const window = normalizeWindow(item, `Additional limit ${index + 1}`);
      if (window) windows.push(window);
    }
  } else if (isRecord(additional)) {
    for (const [key, item] of Object.entries(additional)) {
      const window = normalizeWindow(item, key);
      if (window) windows.push(window);
    }
  }

  const limitReached = readNonEmptyString(
    snapshot["rateLimitReachedType"] ??
      snapshot["rate_limit_reached_type"] ??
      outer["rateLimitReachedType"] ??
      outer["rate_limit_reached_type"],
  );

  // Nothing usable in this message. Absent beats an empty-looking row.
  if (windows.length === 0 && !limitReached) return undefined;

  const displayName =
    readNonEmptyString(
      snapshot["limitName"] ?? snapshot["limit_name"] ?? outer["limitName"] ?? outer["limit_name"],
    ) ?? "Subscription";
  const planType = readNonEmptyString(
    snapshot["planType"] ?? snapshot["plan_type"] ?? outer["planType"] ?? outer["plan_type"],
  );

  const group: QuotaGroup = { key: "default", displayName, windows };

  return {
    providerInstanceId: input.providerInstanceId,
    groups: [group],
    source: "provider-event" satisfies QuotaSource,
    observedAt: input.observedAt,
    ...(planType ? { planType } : {}),
    ...(limitReached ? { limitReached } : {}),
  };
}

/**
 * Claude — the Agent SDK's `rate_limit_event` message, forwarded whole by
 * `ClaudeAdapter.ts`.
 */
export function normalizeClaudeRateLimits(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: unknown;
  readonly observedAt: string;
}): AccountQuotaSnapshot | undefined {
  if (!isRecord(input.payload)) return undefined;

  const outer = readRecord(input.payload, "rateLimits") ?? input.payload;
  const snapshot = readRecord(outer, "rateLimits") ?? readRecord(outer, "rate_limits") ?? outer;

  const windows: Array<QuotaWindow> = [];

  // Check for direct rate_limit_info from SDK's rate_limit_event
  const directInfo =
    readRecord(snapshot, "rate_limit_info") ?? readRecord(snapshot, "rateLimitInfo");
  if (directInfo) {
    const type = readNonEmptyString(directInfo["rateLimitType"] ?? directInfo["rate_limit_type"]);
    const rawUtil = readFiniteNumber(directInfo["utilization"]);
    if (type && rawUtil !== undefined && rawUtil >= 0 && rawUtil <= 1) {
      const usedPercent = Math.round(rawUtil * 100 * 100) / 100;
      const durationMins = type === "five_hour" || type === "primary" ? 300 : 10_080;
      const canonicalId =
        type === "five_hour" || type === "primary"
          ? "claude:five-hour"
          : type === "seven_day" || type === "secondary" || type === "weekly"
            ? "claude:seven-day"
            : `claude:${type.replace(/[^a-z0-9]+/g, "-")}`;
      const label = type === "five_hour" || type === "primary" ? "5-hour limit" : "Weekly limit";
      const resetsAt = isoFromProviderReset(directInfo["resetsAt"] ?? directInfo["resets_at"]);
      windows.push({
        id: canonicalId,
        kind: quotaWindowKindFromDuration(durationMins),
        label,
        usedPercent,
        windowDurationMins: durationMins,
        ...(resetsAt ? { resetsAt } : {}),
      });
    }
  }

  // Named windows, when the SDK labels them.
  for (const [key, label, durationMins, fallbackId] of [
    ["primary", "Session limit", 300, "claude:five-hour"],
    ["secondary", "Weekly limit", 10_080, "claude:seven-day"],
    ["five_hour", "5-hour limit", 300, "claude:five-hour"],
    ["fiveHour", "5-hour limit", 300, "claude:five-hour"],
    ["weekly", "Weekly limit", 10_080, "claude:seven-day"],
    ["seven_day", "Weekly limit", 10_080, "claude:seven-day"],
    ["sevenDay", "Weekly limit", 10_080, "claude:seven-day"],
    ["seven_day_oauth_apps", "OAuth apps weekly limit", 10_080, "claude:seven-day-oauth-apps"],
    ["seven_day_opus", "Opus weekly limit", 10_080, "claude:seven-day-opus"],
    ["seven_day_sonnet", "Sonnet weekly limit", 10_080, "claude:seven-day-sonnet"],
  ] as const) {
    const window = normalizeWindow(snapshot[key], label, durationMins, fallbackId);
    if (window) windows.push(window);
  }

  // Model-scoped windows
  const modelScoped = snapshot["model_scoped"] ?? snapshot["modelScoped"];
  if (Array.isArray(modelScoped)) {
    for (const item of modelScoped) {
      if (!isRecord(item)) continue;
      const modelSlug = readNonEmptyString(item["model"] ?? item["model_id"] ?? item["modelId"]);
      const fallbackId = modelSlug
        ? `claude:seven-day-${modelSlug.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`
        : undefined;
      const displayName =
        readNonEmptyString(item["display_name"] ?? item["displayName"] ?? item["name"]) ??
        modelSlug;
      const label = displayName ? `${displayName} weekly limit` : "Model weekly limit";
      const window = normalizeWindow(item, label, 10_080, fallbackId);
      if (window) windows.push(window);
    }
  }

  // Plain list of windows
  const listed = snapshot["windows"];
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const window = normalizeWindow(entry);
      if (window) windows.push(window);
    }
  }

  // Deduplicate windows by id or (duration + label)
  const uniqueWindows = new Map<string, QuotaWindow>();
  for (const window of windows) {
    const key =
      window.id ?? `${window.kind}:${window.label ?? ""}:${window.windowDurationMins ?? ""}`;
    const existing = uniqueWindows.get(key);
    if (
      !existing ||
      window.usedPercent > existing.usedPercent ||
      (!existing.resetsAt && window.resetsAt)
    ) {
      uniqueWindows.set(key, window);
    }
  }
  const deduplicatedWindows = [...uniqueWindows.values()];

  const limitReached =
    readNonEmptyString(snapshot["rateLimitReachedType"]) ??
    readNonEmptyString(snapshot["status"] === "rejected" ? "rate_limit_reached" : undefined) ??
    (snapshot["limitReached"] === true ? "rate_limit_reached" : undefined);

  if (deduplicatedWindows.length === 0 && !limitReached) return undefined;

  const planType = readNonEmptyString(outer["subscription_type"] ?? snapshot["subscription_type"]);

  return {
    providerInstanceId: input.providerInstanceId,
    groups: [{ key: "default", displayName: "Subscription", windows: deduplicatedWindows }],
    source: "provider-event" satisfies QuotaSource,
    observedAt: input.observedAt,
    ...(planType ? { planType } : {}),
    ...(limitReached ? { limitReached } : {}),
  };
}

/**
 * Antigravity — bridge-provided rate-limit snapshots.
 */
export function normalizeAntigravityRateLimits(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: unknown;
  readonly observedAt: string;
}): AccountQuotaSnapshot | undefined {
  if (!isRecord(input.payload)) return undefined;

  const parsed = parseAntigravityQuotaPayload(input.payload);
  if (!parsed) return undefined;

  return antigravityPayloadToSnapshot(parsed, {
    providerInstanceId: input.providerInstanceId,
    observedAt: input.observedAt,
  });
}

function canonicalPeriodFromId(id: string): string {
  const trimmed = id.trim().toLowerCase().replace(/_/g, "-");
  if (
    trimmed === "five-hour" ||
    trimmed === "primary" ||
    trimmed === "session" ||
    trimmed === "5h" ||
    trimmed === "5-hour"
  ) {
    return "five-hour";
  }
  if (
    trimmed === "seven-day" ||
    trimmed === "secondary" ||
    trimmed === "weekly" ||
    trimmed === "7d" ||
    trimmed === "7-day"
  ) {
    return "seven-day";
  }
  if (trimmed === "monthly" || trimmed === "month" || trimmed === "30d") {
    return "monthly";
  }
  return trimmed;
}

/**
 * Derives a stable semantic key for window deduplication and sparse merging.
 */
export function deriveQuotaWindowKey(window: QuotaWindow, groupKey: string): string {
  const pool = groupKey.toLowerCase().replace(/[^a-z0-9]+/g, "-");
  if (window.id) {
    const canonical = canonicalPeriodFromId(window.id);
    if (canonical.includes(":")) return canonical;
    return `${pool}:${canonical}`;
  }
  const dur = window.windowDurationMins;
  const period =
    dur && dur <= 300
      ? "five-hour"
      : dur && dur <= 10_080
        ? "seven-day"
        : dur && dur <= 43_200
          ? "monthly"
          : window.kind === "short"
            ? "five-hour"
            : window.kind === "long"
              ? "seven-day"
              : (window.label?.toLowerCase().replace(/[^a-z0-9]+/g, "-") ?? "unknown");
  return `${pool}:${period}`;
}

/**
 * Merge a newer sparse update onto the last known snapshot.
 *
 * Windows are merged by stable id or semantic pool/window key, with the newer reading winning.
 * Groups and windows present only in the older snapshot are preserved.
 *
 * `limitReached` is not carried forward from an older snapshot.
 */
export function mergeQuotaSnapshots(
  previous: AccountQuotaSnapshot | undefined,
  next: AccountQuotaSnapshot,
): AccountQuotaSnapshot {
  if (!previous) return next;
  if (previous.providerInstanceId !== next.providerInstanceId) return next;

  const prevTime = Date.parse(previous.observedAt);
  const nextTime = Date.parse(next.observedAt);
  const incomingIsOlder = !Number.isNaN(prevTime) && !Number.isNaN(nextTime) && nextTime < prevTime;
  if (incomingIsOlder) return previous;

  const groupsByKey = new Map<string, QuotaGroup>();
  for (const group of previous.groups) groupsByKey.set(group.key, group);

  for (const incoming of next.groups) {
    const existing = groupsByKey.get(incoming.key);
    if (!existing) {
      groupsByKey.set(incoming.key, incoming);
      continue;
    }

    const windowsByKey = new Map<string, QuotaWindow>();

    if (incomingIsOlder) {
      for (const window of incoming.windows) {
        windowsByKey.set(deriveQuotaWindowKey(window, incoming.key), window);
      }
      for (const window of existing.windows) {
        windowsByKey.set(deriveQuotaWindowKey(window, incoming.key), window);
      }
    } else {
      for (const window of existing.windows) {
        windowsByKey.set(deriveQuotaWindowKey(window, incoming.key), window);
      }
      for (const window of incoming.windows) {
        windowsByKey.set(deriveQuotaWindowKey(window, incoming.key), window);
      }
    }

    groupsByKey.set(incoming.key, {
      key: incoming.key,
      displayName: incoming.displayName || existing.displayName,
      windows: [...windowsByKey.values()],
    });
  }

  const lastAttemptAt =
    next.lastAttemptAt ??
    previous.lastAttemptAt ??
    (incomingIsOlder ? previous.observedAt : next.observedAt);
  const lastSuccessfulAt =
    next.lastSuccessfulAt ?? (next.groups.length > 0 ? next.observedAt : previous.lastSuccessfulAt);

  return {
    providerInstanceId: next.providerInstanceId,
    groups: [...groupsByKey.values()],
    source: incomingIsOlder ? previous.source : next.source,
    observedAt: incomingIsOlder ? previous.observedAt : next.observedAt,
    ...(next.planType || previous.planType
      ? { planType: (incomingIsOlder ? previous.planType : next.planType) ?? previous.planType }
      : {}),
    ...(next.accountLabel || previous.accountLabel
      ? {
          accountLabel:
            (incomingIsOlder ? previous.accountLabel : next.accountLabel) ?? previous.accountLabel,
        }
      : {}),
    ...(next.limitReached ? { limitReached: next.limitReached } : {}),
    ...(lastAttemptAt ? { lastAttemptAt } : {}),
    ...(lastSuccessfulAt ? { lastSuccessfulAt } : {}),
    ...(next.errorCode ? { errorCode: next.errorCode } : {}),
    ...(next.retryAfterMs !== undefined ? { retryAfterMs: next.retryAfterMs } : {}),
    ...(next.retryAt ? { retryAt: next.retryAt } : {}),
    ...((next.resetCredits ?? previous.resetCredits)
      ? { resetCredits: next.resetCredits ?? previous.resetCredits }
      : {}),
  };
}
