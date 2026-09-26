import { DateTime, Option } from "effect";
/**
 * Pure parsing and normalization primitives for Antigravity quota sources.
 *
 * Shared between the direct Antigravity driver, local endpoint probes,
 * CLI output parsing, and runtime event normalizers.
 *
 * @module quota/antigravityQuotaParser
 */
import {
  type AccountQuotaSnapshot,
  type QuotaGroup,
  type QuotaSource,
  type QuotaWindow,
  quotaWindowKindFromDuration,
} from "@t3tools/contracts/quota";
import type { ProviderInstanceId, ProviderUsageLimitsUpdate } from "@t3tools/contracts";

export const WEEK_MINS = 7 * 24 * 60;
export const MONTH_MINS = 30 * 24 * 60;

export interface AntigravityUsageWindow {
  readonly id?: string;
  readonly label: string;
  readonly usedPercent: number;
  readonly windowDurationMins: number;
  readonly resetsAt?: string;
}

export interface AntigravityUsageGroup {
  readonly key: "gemini" | "claude-gpt" | string;
  readonly displayName: string;
  readonly windows: ReadonlyArray<AntigravityUsageWindow>;
}

export interface AntigravityUsagePayload {
  readonly groups: ReadonlyArray<AntigravityUsageGroup>;
  readonly source?: "antigravity-quota-summary" | "antigravity-model-fallback";
  readonly accountLabel?: string;
  readonly planType?: string;
  readonly limitReached?: string;
}

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

export function parseResetTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    if (value >= 1_000_000_000 && value <= 4_102_444_800) {
      return DateTime.formatIso(DateTime.makeUnsafe(value * 1000));
    }
    if (value >= 1_000_000_000_000 && value <= 4_102_444_800_000) {
      return DateTime.formatIso(DateTime.makeUnsafe(value));
    }
    return undefined;
  }
  const text = readNonEmptyString(value);
  if (!text) return undefined;
  if (/^\d+(\.\d+)?$/.test(text)) {
    return parseResetTimestamp(Number(text));
  }
  const parsed = DateTime.make(text);
  if (Option.isNone(parsed)) return undefined;
  return text;
}

/**
 * Valid percentage within [0, 100]. A slight overshoot (e.g. 101%)
 * is clamped to 100, but malformed numbers (<0 or >105) are rejected.
 */
export function parseQuotaPercent(value: unknown): number | undefined {
  const num = readFiniteNumber(value);
  if (num === undefined) return undefined;
  if (num < 0 || num > 105) return undefined;
  return Math.min(100, Math.max(0, Math.round(num * 100) / 100));
}

/**
 * Valid remaining fraction in [0, 1]. Never clamp invalid numbers into
 * plausible fractions; reject anything outside [0, 1].
 */
export function remainingFractionToUsedPercent(value: unknown): number | undefined {
  const num = readFiniteNumber(value);
  if (num === undefined || num < 0 || num > 1) return undefined;
  return Math.round((100 - num * 100) * 100) / 100;
}

/**
 * Valid remaining percent in [0, 100]. Rejects out-of-range numbers.
 */
export function remainingPercentToUsedPercent(value: unknown): number | undefined {
  const num = readFiniteNumber(value);
  if (num === undefined || num < 0 || num > 100) return undefined;
  return Math.round((100 - num) * 100) / 100;
}

/**
 * Extract canonical usedPercent from an Antigravity bucket.
 * Accepts camelCase and snake_case field names.
 */
export function parseBucketUsedPercent(bucket: Record<string, unknown>): number | undefined {
  const frac = bucket["remainingFraction"] ?? bucket["remaining_fraction"];
  if (frac !== undefined) {
    const used = remainingFractionToUsedPercent(frac);
    if (used !== undefined) return used;
  }

  const remPct = bucket["remainingPercent"] ?? bucket["remaining_percent"];
  if (remPct !== undefined) {
    const used = remainingPercentToUsedPercent(remPct);
    if (used !== undefined) return used;
  }

  const rawUsed = bucket["usedPercent"] ?? bucket["used_percent"] ?? bucket["utilization"];
  if (rawUsed !== undefined) {
    const used = parseQuotaPercent(rawUsed);
    if (used !== undefined) return used;
  }

  return undefined;
}

/**
 * Parse window duration in minutes from numeric or textual descriptor.
 */
export function parseWindowDurationMins(value: unknown, fallbackText?: string): number | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value;
  }
  const text = typeof value === "string" ? value : fallbackText;
  if (!text) return undefined;
  if (/(?:five.?hour|5.?hour|5h|session|short|primary)/iu.test(text)) return 300;
  if (/(?:weekly|week|seven.?day|7d|long|secondary)/iu.test(text)) return WEEK_MINS;
  if (/(?:monthly|month|30d)/iu.test(text)) return MONTH_MINS;
  return undefined;
}

/**
 * Clean window label.
 */
export function cleanWindowLabel(
  label: string | undefined,
  durationMins: number | undefined,
): string {
  if (label) {
    const cleaned = label.replace(/\s+remaining$/iu, "").trim();
    if (cleaned.length > 0) return cleaned;
  }
  if (!durationMins) return "Limit";
  if (durationMins >= MONTH_MINS) return "Monthly";
  if (durationMins >= WEEK_MINS) return "Weekly";
  return "5-hour";
}

/**
 * Identify whether a group/pool represents Gemini, Claude/GPT, or a credit balance.
 */
export function classifyAntigravityIdentity(
  key: string,
  displayName: string,
): {
  readonly poolKey: "gemini" | "claude-gpt" | "credit" | "other";
  readonly defaultDisplayName: string;
} {
  const combined = `${key} ${displayName}`;
  // Prompt/flow credits or QuotaManager must NOT become Gemini subscription bars!
  if (/credit|prompt.?credit|flow.?credit|quotamanager/iu.test(combined)) {
    return { poolKey: "credit", defaultDisplayName: displayName || "Credits" };
  }
  if (/gemini|google/iu.test(combined)) {
    return { poolKey: "gemini", defaultDisplayName: "Gemini" };
  }
  if (/claude|gpt|oss/iu.test(combined)) {
    return { poolKey: "claude-gpt", defaultDisplayName: "Claude & GPT" };
  }
  return {
    poolKey: "other",
    defaultDisplayName: displayName || key,
  };
}

/**
 * Parse one Antigravity bucket into a normalized window.
 */
export function parseAntigravityBucket(
  bucketValue: unknown,
  poolKey: string,
  fallbackLabel?: string,
  fallbackDurationMins?: number,
  generateFallbackId: boolean = true,
): AntigravityUsageWindow | undefined {
  if (!isRecord(bucketValue) || bucketValue["disabled"] === true) return undefined;

  const usedPercent = parseBucketUsedPercent(bucketValue);
  if (usedPercent === undefined) return undefined;

  const rawDescriptor = `${bucketValue["window"] ?? ""} ${bucketValue["displayName"] ?? ""} ${bucketValue["name"] ?? ""}`;
  const durationMins =
    parseWindowDurationMins(bucketValue["windowDurationMins"] ?? bucketValue["window_minutes"]) ??
    parseWindowDurationMins(bucketValue["window"], rawDescriptor) ??
    fallbackDurationMins;

  if (durationMins === undefined || durationMins <= 0) return undefined;

  const rawBucketId =
    readNonEmptyString(bucketValue["bucketId"]) ??
    readNonEmptyString(bucketValue["bucket_id"]) ??
    readNonEmptyString(bucketValue["id"]);
  const id = rawBucketId ?? (generateFallbackId ? `${poolKey}-${durationMins}` : undefined);

  const rawLabel =
    readNonEmptyString(bucketValue["label"]) ??
    readNonEmptyString(bucketValue["displayName"]) ??
    readNonEmptyString(bucketValue["name"]) ??
    fallbackLabel;
  const label = cleanWindowLabel(rawLabel, durationMins);

  const rawReset =
    bucketValue["resetTime"] ??
    bucketValue["reset_time"] ??
    bucketValue["resetsAt"] ??
    bucketValue["resets_at"];
  const resetsAt = parseResetTimestamp(rawReset);

  return {
    ...(id ? { id } : {}),
    label,
    usedPercent,
    windowDurationMins: durationMins,
    ...(resetsAt ? { resetsAt } : {}),
  };
}

/**
 * Pure parser for arbitrary Antigravity quota responses:
 * accepts root objects, nested quotaSummary/quotaGroups/modelGroups/pools,
 * arrays or maps of groups, and arrays or maps of buckets.
 */
export function parseAntigravityQuotaPayload(
  value: unknown,
  options?: { readonly generateWindowIds?: boolean },
): AntigravityUsagePayload | undefined {
  if (!isRecord(value)) return undefined;

  const generateWindowIds = options?.generateWindowIds ?? true;

  // Search through nested layers for groups or buckets
  const candidates: Record<string, unknown>[] = [];
  const queue: unknown[] = [value];
  const seen = new Set<unknown>();

  while (queue.length > 0 && candidates.length < 10) {
    const current = queue.shift();
    if (!isRecord(current) || seen.has(current)) continue;
    seen.add(current);
    candidates.push(current);

    for (const key of [
      "rateLimits",
      "rate_limits",
      "quotaSummary",
      "command",
      "data",
      "response",
      "payload",
    ]) {
      const child = current[key];
      if (isRecord(child)) queue.push(child);
    }
  }

  // Find the candidate record containing the most specific quota fields
  let record: Record<string, unknown> = value;
  for (const cand of candidates) {
    if (
      cand["groups"] ||
      cand["quotaGroups"] ||
      cand["pools"] ||
      cand["quota_groups"] ||
      cand["modelGroups"]
    ) {
      record = cand;
      break;
    }
  }

  const explicitModelGroups = record["modelGroups"] ?? value["modelGroups"];
  const isModelFallback =
    (!record["groups"] &&
      !record["quotaGroups"] &&
      !record["pools"] &&
      !record["quota_groups"] &&
      Boolean(explicitModelGroups)) ||
    candidates.some((c) => c["source"] === "antigravity-model-fallback");

  const rawGroups =
    record["groups"] ??
    record["quotaGroups"] ??
    record["pools"] ??
    record["quota_groups"] ??
    explicitModelGroups;

  const groupEntries: Array<{ readonly rawKey?: string; readonly value: unknown }> = Array.isArray(
    rawGroups,
  )
    ? rawGroups.map((group) => ({ value: group }))
    : isRecord(rawGroups)
      ? Object.entries(rawGroups).map(([rawKey, val]) => ({ rawKey, value: val }))
      : [{ value: record }];

  const groupsByKey = new Map<
    string,
    {
      displayName: string;
      windowsByDuration: Map<number, AntigravityUsageWindow>;
    }
  >();

  for (const entry of groupEntries) {
    if (!isRecord(entry.value)) continue;
    const groupRecord =
      readRecord(entry.value, "rateLimits") ??
      readRecord(entry.value, "rate_limits") ??
      entry.value;

    const rawName =
      readNonEmptyString(groupRecord["displayName"]) ??
      readNonEmptyString(groupRecord["name"]) ??
      readNonEmptyString(groupRecord["modelId"]) ??
      readNonEmptyString(groupRecord["label"]) ??
      entry.rawKey ??
      "";
    const rawKey =
      readNonEmptyString(groupRecord["key"]) ??
      readNonEmptyString(groupRecord["id"]) ??
      entry.rawKey ??
      rawName;

    const identity = classifyAntigravityIdentity(rawKey, rawName);
    // Skip credits from being treated as subscription quota bars
    if (identity.poolKey === "credit") continue;

    if (isModelFallback && identity.poolKey !== "gemini" && identity.poolKey !== "claude-gpt") {
      continue;
    }

    const poolKey =
      identity.poolKey === "gemini"
        ? "gemini"
        : identity.poolKey === "claude-gpt"
          ? "claude-gpt"
          : rawKey.toLowerCase().replace(/[^a-z0-9]+/g, "-");

    const displayName = isModelFallback
      ? identity.poolKey === "gemini"
        ? "Gemini Models"
        : identity.poolKey === "claude-gpt"
          ? "Claude & GPT models"
          : identity.defaultDisplayName
      : (readNonEmptyString(groupRecord["name"]) ??
        (identity.poolKey === "gemini"
          ? "Gemini"
          : identity.poolKey === "claude-gpt"
            ? "Claude & GPT"
            : (readNonEmptyString(groupRecord["displayName"]) ?? identity.defaultDisplayName)));

    const bucketsValue =
      groupRecord["buckets"] ??
      groupRecord["quotaBuckets"] ??
      groupRecord["windows"] ??
      groupRecord["limits"];

    const bucketList: Array<{
      readonly bucket: unknown;
      readonly fallbackLabel?: string;
      readonly fallbackDurationMins?: number;
    }> = [];
    if (Array.isArray(bucketsValue)) {
      for (const b of bucketsValue) bucketList.push({ bucket: b });
    } else if (isRecord(bucketsValue)) {
      for (const [key, b] of Object.entries(bucketsValue)) {
        const dur = /(?:five.?hour|5.?hour|primary|short)/iu.test(key)
          ? 300
          : /(?:weekly|seven.?day|secondary|long)/iu.test(key)
            ? WEEK_MINS
            : undefined;
        bucketList.push({
          bucket: b,
          fallbackLabel: key,
          ...(dur !== undefined ? { fallbackDurationMins: dur } : {}),
        });
      }
    } else {
      // Direct keys on group record (e.g. weekly: { utilization: 67 })
      for (const [key, val] of Object.entries(groupRecord)) {
        if (["key", "id", "name", "label", "displayName", "description", "modelId"].includes(key)) {
          continue;
        }
        if (isRecord(val)) {
          const dur = /(?:five.?hour|5.?hour|primary|short)/iu.test(key)
            ? 300
            : /(?:weekly|seven.?day|secondary|long)/iu.test(key)
              ? WEEK_MINS
              : undefined;
          bucketList.push({
            bucket: val,
            fallbackLabel: key,
            ...(dur !== undefined ? { fallbackDurationMins: dur } : {}),
          });
        }
      }
    }

    const parsedWindows: AntigravityUsageWindow[] = [];
    for (const item of bucketList) {
      const window = parseAntigravityBucket(
        item.bucket,
        poolKey,
        item.fallbackLabel,
        item.fallbackDurationMins,
        generateWindowIds,
      );
      if (window) parsedWindows.push(window);
    }

    if (parsedWindows.length === 0) continue;

    const existingGroup = groupsByKey.get(poolKey);
    const windowMap = existingGroup?.windowsByDuration ?? new Map<number, AntigravityUsageWindow>();

    for (const window of parsedWindows) {
      const existing = windowMap.get(window.windowDurationMins);
      // For model fallback, pick the limiting bucket (highest used percentage).
      // For shared pools, highest used or better reset time wins.
      if (
        !existing ||
        window.usedPercent > existing.usedPercent ||
        (window.usedPercent === existing.usedPercent && !existing.resetsAt && window.resetsAt)
      ) {
        windowMap.set(window.windowDurationMins, window);
      }
    }

    groupsByKey.set(poolKey, {
      displayName: existingGroup?.displayName ?? displayName,
      windowsByDuration: windowMap,
    });
  }

  if (groupsByKey.size === 0) return undefined;

  const groups: AntigravityUsageGroup[] = [...groupsByKey.entries()].map(([key, data]) => ({
    key,
    displayName: data.displayName,
    windows: [...data.windowsByDuration.values()],
  }));

  let planType: string | undefined;
  let accountLabel: string | undefined;
  let limitReached: string | undefined;

  for (const cand of candidates) {
    if (!planType) {
      planType =
        readNonEmptyString(cand["plan_type"]) ??
        readNonEmptyString(cand["planType"]) ??
        readNonEmptyString(cand["subscription_type"]) ??
        readNonEmptyString(cand["subscriptionType"]);
    }
    if (!accountLabel) {
      accountLabel = readNonEmptyString(cand["accountLabel"]) ?? readNonEmptyString(cand["email"]);
    }
    if (!limitReached) {
      limitReached =
        readNonEmptyString(cand["limitReached"]) ??
        readNonEmptyString(cand["rateLimitReachedType"]) ??
        (cand["limitReached"] === true ? "rate_limit_reached" : undefined);
    }
  }

  const explicitSource = candidates
    .map((c) => readNonEmptyString(c["source"]))
    .find((s) => s !== undefined);
  const source =
    explicitSource === "antigravity-model-fallback" || isModelFallback
      ? ("antigravity-model-fallback" as const)
      : undefined;

  return {
    groups,
    ...(source ? { source } : {}),
    ...(planType ? { planType } : {}),
    ...(accountLabel ? { accountLabel } : {}),
    ...(limitReached ? { limitReached } : {}),
  };
}

/**
 * Convert AntigravityUsagePayload into the shared AccountQuotaSnapshot read model.
 */
export function antigravityPayloadToSnapshot(
  payload: AntigravityUsagePayload,
  input: {
    readonly providerInstanceId: ProviderInstanceId;
    readonly observedAt: string;
  },
): AccountQuotaSnapshot {
  const groups: Array<QuotaGroup> = payload.groups.map((group) => ({
    key: group.key,
    displayName: group.displayName,
    windows: group.windows.map((w): QuotaWindow => {
      let resetsAt: string | undefined;
      if (w.resetsAt) {
        const parsed = DateTime.make(w.resetsAt);
        resetsAt = Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : w.resetsAt;
      }
      return {
        ...(w.id ? { id: w.id } : {}),
        kind: quotaWindowKindFromDuration(w.windowDurationMins),
        label: w.label,
        usedPercent: w.usedPercent,
        windowDurationMins: w.windowDurationMins,
        ...(resetsAt ? { resetsAt } : {}),
      };
    }),
  }));

  return {
    providerInstanceId: input.providerInstanceId,
    groups,
    source: payload.source ?? "antigravity-quota-summary",
    observedAt: input.observedAt,
    ...(payload.planType ? { planType: payload.planType } : {}),
    ...(payload.accountLabel ? { accountLabel: payload.accountLabel } : {}),
    ...(payload.limitReached ? { limitReached: payload.limitReached } : {}),
  };
}

/**
 * Convert AntigravityUsagePayload into ProviderUsageLimitsUpdate for ServerProvider.usageLimits.
 */
export function antigravityPayloadToUsageLimits(
  payload: AntigravityUsagePayload,
): ProviderUsageLimitsUpdate {
  return {
    windows: payload.groups
      .toSorted((left, right) => Number(right.key === "gemini") - Number(left.key === "gemini"))
      .flatMap((group) =>
        group.windows
          .toSorted((left, right) => left.windowDurationMins - right.windowDurationMins)
          .map((window) => ({
            id: window.id ?? `${group.key}-${window.windowDurationMins}`,
            kind:
              window.windowDurationMins >= MONTH_MINS
                ? ("monthly" as const)
                : window.windowDurationMins >= WEEK_MINS
                  ? ("weekly" as const)
                  : ("session" as const),
            label: `${group.displayName} ${window.label}`,
            usedPercent: window.usedPercent,
            ...(window.resetsAt ? { resetsAt: window.resetsAt } : {}),
            windowDurationMins: window.windowDurationMins,
          })),
      ),
  };
}
