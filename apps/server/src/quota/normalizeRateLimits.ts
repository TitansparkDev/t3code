// @effect-diagnostics globalDate:off - pure normalizer; converts provider epochs, reads no clock.
/**
 * Normalizes each provider's `account.rate-limits.updated` payload into the
 * shared `AccountQuotaSnapshot` shape.
 *
 * Both the Codex and Claude adapters already emit that runtime event with the
 * provider's raw payload attached (`CodexAdapter.ts`, `ClaudeAdapter.ts`);
 * before this module nothing consumed it. These functions are the whole
 * provider-specific surface — everything downstream reads the normalized shape
 * and does not know which agent produced it.
 *
 * Pure and total by construction: every function takes `unknown` and returns a
 * snapshot or `undefined`. A payload that changed shape yields `undefined`,
 * which the UI renders as "not exposed". It must never yield a plausible-looking
 * number, because a wrong quota figure is worse than an absent one — it gets
 * trusted.
 *
 * Fork-local (OmniCode). See `OMNI.md`.
 *
 * @module quota/normalizeRateLimits
 */
import type {
  AccountQuotaSnapshot,
  QuotaGroup,
  QuotaSource,
  QuotaWindow,
} from "@t3tools/contracts/quota";
import { quotaWindowKindFromDuration } from "@t3tools/contracts/quota";
import type { ProviderInstanceId } from "@t3tools/contracts";

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
 * discard the reading.
 */
function readUsedPercent(value: unknown): number | undefined {
  const raw = readFiniteNumber(value);
  if (raw === undefined) return undefined;
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

function isoFromProviderReset(value: unknown): string | undefined {
  const text = readNonEmptyString(value);
  if (text === undefined) return isoFromEpochSeconds(value);
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? undefined : date.toISOString();
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
): QuotaWindow | undefined {
  if (!isRecord(value) || value["disabled"] === true) return undefined;
  const usedPercent = readUsedPercent(
    value["usedPercent"] ?? value["used_percent"] ?? value["utilization"],
  );
  if (usedPercent === undefined) return undefined;

  const windowDurationMins =
    readFiniteNumber(value["windowDurationMins"] ?? value["window_minutes"]) ??
    fallbackDurationMins;
  const rawReset = value["resetsAt"] ?? value["resets_at"];
  const resetsAt = isoFromProviderReset(rawReset);
  const label = readNonEmptyString(value["label"]) ?? fallbackLabel;

  return {
    kind: quotaWindowKindFromDuration(windowDurationMins),
    usedPercent,
    ...(label ? { label } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined && windowDurationMins > 0 ? { windowDurationMins } : {}),
  };
}

/**
 * Antigravity's ACP bridge publishes quota as `remaining_fraction`, while
 * older bridge builds have used explicit remaining-percent fields. Keep that
 * conversion here instead of making every consumer know which side of the
 * percentage the provider reports.
 */
function normalizeAntigravityWindow(
  value: unknown,
  fallbackLabel?: string,
  fallbackDurationMins?: number,
): QuotaWindow | undefined {
  if (!isRecord(value)) return undefined;

  const explicitUsed = readUsedPercent(
    value["usedPercent"] ?? value["used_percent"] ?? value["utilization"],
  );
  const remainingPercent = readFiniteNumber(
    value["remainingPercent"] ?? value["remaining_percent"],
  );
  const remainingFraction = readFiniteNumber(
    value["remaining_fraction"] ?? value["remainingFraction"],
  );
  const usedPercent =
    explicitUsed ??
    (remainingPercent === undefined
      ? remainingFraction === undefined
        ? undefined
        : readUsedPercent(
            Math.round((100 - Math.min(1, Math.max(0, remainingFraction)) * 100) * 100) / 100,
          )
      : readUsedPercent(100 - Math.min(100, Math.max(0, remainingPercent))));
  if (usedPercent === undefined) return undefined;

  const windowHint = readNonEmptyString(value["window"]);
  const hintedDurationMins = windowHint
    ? /(?:five.?hour|5.?hour|5h|session)/i.test(windowHint)
      ? 300
      : /(?:weekly|week|seven.?day|7d)/i.test(windowHint)
        ? 10_080
        : undefined
    : undefined;
  const windowDurationMins =
    readFiniteNumber(value["windowDurationMins"] ?? value["window_minutes"]) ??
    hintedDurationMins ??
    fallbackDurationMins;
  const rawReset =
    value["resetsAt"] ?? value["resets_at"] ?? value["resetTime"] ?? value["reset_time"];
  const resetsAt = isoFromProviderReset(rawReset);
  const rawLabel = readNonEmptyString(value["label"]) ?? readNonEmptyString(value["name"]);
  const label = (rawLabel ?? fallbackLabel)?.replace(/\s+remaining$/iu, "");

  return {
    kind: quotaWindowKindFromDuration(windowDurationMins),
    usedPercent,
    ...(label ? { label } : {}),
    ...(resetsAt ? { resetsAt } : {}),
    ...(windowDurationMins !== undefined && windowDurationMins > 0 ? { windowDurationMins } : {}),
  };
}

/**
 * Codex — `account/rateLimits/updated`, schema
 * `V2AccountRateLimitsUpdatedNotification` in `packages/effect-codex-app-server`.
 *
 * The payload is explicitly documented as a **sparse rolling update**: fields
 * absent from one message do not clear a previously observed value. Merging is
 * the caller's job (see `mergeQuotaSnapshots`); this function reports only what
 * this message actually carried.
 */
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
    const usedPercent = entry["usedPercent"];
    if (typeof usedPercent !== "number") continue;
    const kind = entry["kind"];
    const label = entry["label"];
    const resetsAt = entry["resetsAt"];
    const windowDurationMins = entry["windowDurationMins"];
    // Upstream names windows by period; this panel groups them by how long
    // they last, so a session window is short and anything weekly or longer
    // is long.
    windows.push({
      kind:
        kind === "session" ? "short" : kind === "weekly" || kind === "monthly" ? "long" : "unknown",
      ...(typeof label === "string" && label.trim() ? { label: label.trim() } : {}),
      usedPercent,
      ...(typeof resetsAt === "string" && resetsAt.trim() ? { resetsAt } : {}),
      ...(typeof windowDurationMins === "number" && windowDurationMins > 0
        ? { windowDurationMins }
        : {}),
    } satisfies QuotaWindow);
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

  // The adapter wraps the notification as `{ rateLimits: <notification> }`, and
  // the notification itself nests a `rateLimits` snapshot. Accept either depth
  // so a future unwrap upstream does not silently blank the panel.
  const outer = readRecord(input.payload, "rateLimits") ?? input.payload;
  const snapshot = readRecord(outer, "rateLimits") ?? outer;

  const windows: Array<QuotaWindow> = [];
  const primary = normalizeWindow(snapshot["primary"]);
  if (primary) windows.push(primary);
  const secondary = normalizeWindow(snapshot["secondary"]);
  if (secondary) windows.push(secondary);

  const limitReached = readNonEmptyString(
    snapshot["rateLimitReachedType"] ?? snapshot["rate_limit_reached_type"],
  );

  // Nothing usable in this message. Absent beats an empty-looking row.
  if (windows.length === 0 && !limitReached) return undefined;

  const displayName =
    readNonEmptyString(snapshot["limitName"] ?? snapshot["limit_name"]) ?? "Subscription";
  const planType = readNonEmptyString(snapshot["planType"] ?? snapshot["plan_type"]);

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
 *
 * Unlike Codex there is no generated schema for this in the repo, and the SDK's
 * own types have carried wire-only fields before. So this reads defensively
 * across the shapes the SDK has been observed to use rather than pinning one:
 * a nested `rateLimits`/`rate_limits` object, or the windows inline. Anything
 * unrecognized returns `undefined` and the row reads "not exposed" — which is
 * the correct answer until someone confirms the real shape against a live
 * account.
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

  // Named windows, when the SDK labels them.
  for (const [key, label, durationMins] of [
    ["primary", "Session limit", undefined],
    ["secondary", "Weekly limit", undefined],
    ["five_hour", "5-hour limit", 300],
    ["fiveHour", "5-hour limit", 300],
    ["weekly", "Weekly limit", 10_080],
    ["seven_day", "Weekly limit", 10_080],
    ["sevenDay", "Weekly limit", 10_080],
    ["seven_day_oauth_apps", "OAuth apps weekly limit", 10_080],
    ["seven_day_opus", "Opus weekly limit", 10_080],
    ["seven_day_sonnet", "Sonnet weekly limit", 10_080],
  ] as const) {
    const window = normalizeWindow(snapshot[key], label, durationMins);
    if (window) windows.push(window);
  }

  // Or a plain list of windows.
  const listed = snapshot["windows"];
  if (Array.isArray(listed)) {
    for (const entry of listed) {
      const window = normalizeWindow(entry);
      if (window) windows.push(window);
    }
  }

  const limitReached =
    readNonEmptyString(snapshot["rateLimitReachedType"]) ??
    readNonEmptyString(snapshot["status"]) ??
    (snapshot["limitReached"] === true ? "rate_limit_reached" : undefined);

  if (windows.length === 0 && !limitReached) return undefined;
  const planType = readNonEmptyString(outer["subscription_type"]);

  return {
    providerInstanceId: input.providerInstanceId,
    groups: [{ key: "default", displayName: "Subscription", windows }],
    source: "provider-event" satisfies QuotaSource,
    observedAt: input.observedAt,
    ...(planType ? { planType } : {}),
    ...(limitReached ? { limitReached } : {}),
  };
}

/**
 * Antigravity — bridge-provided rate-limit snapshots.
 *
 * Bridges in the wild use both `groups` and `pools`, and name windows either
 * as a list or as keyed objects. Read those equivalent shapes defensively,
 * retaining a pool only when at least one window contains an explicit usage
 * percentage. This keeps an ACP bridge's account metadata from becoming a
 * guessed quota number.
 */
export function normalizeAntigravityRateLimits(input: {
  readonly providerInstanceId: ProviderInstanceId;
  readonly payload: unknown;
  readonly observedAt: string;
}): AccountQuotaSnapshot | undefined {
  if (!isRecord(input.payload)) return undefined;

  const outer =
    readRecord(input.payload, "rateLimits") ??
    readRecord(input.payload, "rate_limits") ??
    input.payload;
  const snapshot = readRecord(outer, "rateLimits") ?? readRecord(outer, "rate_limits") ?? outer;
  const explicitModelGroups = snapshot["modelGroups"] ?? input.payload["modelGroups"];
  const isModelFallback =
    (!snapshot["groups"] &&
      !snapshot["pools"] &&
      !snapshot["quotaGroups"] &&
      !snapshot["quota_groups"] &&
      Boolean(explicitModelGroups)) ||
    snapshot["source"] === "antigravity-model-fallback" ||
    outer["source"] === "antigravity-model-fallback" ||
    input.payload["source"] === "antigravity-model-fallback";

  const groupsValue =
    snapshot["groups"] ??
    snapshot["pools"] ??
    snapshot["quotaGroups"] ??
    snapshot["quota_groups"] ??
    explicitModelGroups;

  const candidates: Array<{ readonly key: string; readonly value: unknown }> = Array.isArray(
    groupsValue,
  )
    ? groupsValue.map((value, index) => ({ key: `pool-${index + 1}`, value }))
    : isRecord(groupsValue)
      ? Object.entries(groupsValue).map(([key, value]) => ({ key, value }))
      : [{ key: "default", value: snapshot }];

  const groupsByKey = new Map<string, { displayName: string; windows: Map<number, QuotaWindow> }>();

  for (const candidate of candidates) {
    if (!isRecord(candidate.value)) continue;
    const group =
      readRecord(candidate.value, "rateLimits") ??
      readRecord(candidate.value, "rate_limits") ??
      candidate.value;
    const windows: Array<QuotaWindow> = [];
    const listedWindows =
      group["windows"] ?? group["limits"] ?? group["buckets"] ?? group["quotaBuckets"];
    if (Array.isArray(listedWindows)) {
      for (const value of listedWindows) {
        const window = normalizeAntigravityWindow(value);
        if (window) windows.push(window);
      }
    } else {
      for (const [key, value] of Object.entries(group)) {
        if (["key", "id", "name", "label", "displayName", "description"].includes(key)) {
          continue;
        }
        const fallbackDurationMins = /(?:five.?hour|5.?hour|primary|short)/i.test(key)
          ? 300
          : /(?:weekly|seven.?day|secondary|long)/i.test(key)
            ? 10_080
            : undefined;
        const window = normalizeAntigravityWindow(value, key, fallbackDurationMins);
        if (window) windows.push(window);
      }
    }

    if (windows.length === 0) continue;
    const rawDisplayName =
      readNonEmptyString(group["displayName"]) ??
      readNonEmptyString(group["name"]) ??
      readNonEmptyString(group["modelId"]) ??
      readNonEmptyString(group["label"]) ??
      candidate.key;
    const rawKey =
      readNonEmptyString(group["key"]) ?? readNonEmptyString(group["id"]) ?? candidate.key;
    const identity = `${rawKey} ${rawDisplayName}`;
    const isGemini = /gemini|google/i.test(identity);
    const isClaudeGpt = /claude|gpt|oss/i.test(identity);

    if (isModelFallback && !isGemini && !isClaudeGpt) {
      continue;
    }

    const key = isGemini ? "gemini" : isClaudeGpt ? "claude-gpt" : rawKey;
    const defaultDisplayName =
      key === "gemini"
        ? "Gemini Models"
        : key === "claude-gpt"
          ? "Claude & GPT models"
          : rawDisplayName;
    const displayName = isModelFallback ? defaultDisplayName : rawDisplayName;

    const existingGroup = groupsByKey.get(key);
    const windowMap = existingGroup?.windows ?? new Map<number, QuotaWindow>();

    for (const window of windows) {
      const duration =
        window.windowDurationMins ??
        (window.kind === "short" ? 300 : window.kind === "long" ? 10_080 : 0);
      const existing = windowMap.get(duration);
      if (
        !existing ||
        window.usedPercent > existing.usedPercent ||
        (window.usedPercent === existing.usedPercent && !existing.resetsAt && window.resetsAt)
      ) {
        windowMap.set(duration, window);
      }
    }

    groupsByKey.set(key, {
      displayName: existingGroup?.displayName ?? displayName,
      windows: windowMap,
    });
  }

  const groups: Array<QuotaGroup> = [...groupsByKey.entries()].map(([key, data]) => ({
    key,
    displayName: data.displayName,
    windows: [...data.windows.values()],
  }));

  const limitReached =
    readNonEmptyString(snapshot["limitReached"]) ??
    readNonEmptyString(snapshot["rateLimitReachedType"]) ??
    (snapshot["limitReached"] === true ? "rate_limit_reached" : undefined);
  if (groups.length === 0 && !limitReached) return undefined;

  const planType =
    readNonEmptyString(snapshot["planType"]) ??
    readNonEmptyString(snapshot["plan_type"]) ??
    readNonEmptyString(snapshot["subscriptionType"]) ??
    readNonEmptyString(snapshot["subscription_type"]);
  const accountLabel =
    readNonEmptyString(input.payload["accountLabel"]) ??
    readNonEmptyString(snapshot["accountLabel"]) ??
    readNonEmptyString(snapshot["account"]) ??
    readNonEmptyString(snapshot["email"]);

  const explicitSource =
    readNonEmptyString(snapshot["source"]) ??
    readNonEmptyString(outer["source"]) ??
    readNonEmptyString(input.payload["source"]);
  const source: QuotaSource =
    explicitSource === "antigravity-model-fallback" || isModelFallback
      ? "antigravity-model-fallback"
      : explicitSource === "antigravity-quota-summary"
        ? "antigravity-quota-summary"
        : "provider-event";

  return {
    providerInstanceId: input.providerInstanceId,
    groups,
    source,
    observedAt: input.observedAt,
    ...(planType ? { planType } : {}),
    ...(limitReached ? { limitReached } : {}),
    ...(accountLabel ? { accountLabel } : {}),
  };
}

/**
 * Merge a newer sparse update onto the last known snapshot.
 *
 * Required because Codex documents its updates as sparse: a rolling message
 * carrying only `primary` must not erase the `secondary` window a person is
 * relying on. Windows are merged by kind, with the newer reading winning; a
 * group present only in the older snapshot is preserved.
 *
 * `limitReached` is the exception — it is *not* carried forward, because a
 * stale "you are rate limited" that outlives the reset is precisely the state
 * that makes an account look permanently broken.
 */
export function mergeQuotaSnapshots(
  previous: AccountQuotaSnapshot | undefined,
  next: AccountQuotaSnapshot,
): AccountQuotaSnapshot {
  if (!previous) return next;
  if (previous.providerInstanceId !== next.providerInstanceId) return next;

  const groupsByKey = new Map<string, QuotaGroup>();
  for (const group of previous.groups) groupsByKey.set(group.key, group);

  for (const incoming of next.groups) {
    const existing = groupsByKey.get(incoming.key);
    if (!existing) {
      groupsByKey.set(incoming.key, incoming);
      continue;
    }

    const windowsByKind = new Map<string, QuotaWindow>();
    for (const window of existing.windows) {
      windowsByKind.set(`${window.kind}:${window.label ?? ""}`, window);
    }
    for (const window of incoming.windows) {
      windowsByKind.set(`${window.kind}:${window.label ?? ""}`, window);
    }

    groupsByKey.set(incoming.key, {
      key: incoming.key,
      displayName: incoming.displayName,
      windows: [...windowsByKind.values()],
    });
  }

  return {
    providerInstanceId: next.providerInstanceId,
    groups: [...groupsByKey.values()],
    source: next.source,
    observedAt: next.observedAt,
    ...((next.planType ?? previous.planType)
      ? { planType: next.planType ?? previous.planType! }
      : {}),
    ...(next.limitReached ? { limitReached: next.limitReached } : {}),
    // Account identity is not published on every update; keeping the last known
    // one stops a sparse refresh from ungrouping instances that share it.
    ...((next.accountLabel ?? previous.accountLabel)
      ? { accountLabel: next.accountLabel ?? previous.accountLabel! }
      : {}),
  };
}
