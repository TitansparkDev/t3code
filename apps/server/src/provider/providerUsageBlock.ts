import type { ServerProvider } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

/** Words in a usage window's name that say nothing about which models it covers. */
const GENERIC_WINDOW_WORDS = new Set([
  "weekly",
  "daily",
  "monthly",
  "session",
  "hour",
  "hours",
  "day",
  "days",
  "week",
  "month",
  "limit",
  "limits",
  "usage",
  "quota",
  "five",
  "seven",
  "thirty",
  "primary",
  "secondary",
  "window",
  "rolling",
  "spend",
  "credits",
]);

/**
 * Whether a usage window covers `model`. A window named for a model family
 * (Claude's `seven_day_opus`, Antigravity's "Gemini 3 Flash") covers only models
 * that carry all of those words; a plain session or weekly window covers every model.
 */
function windowCoversModel(
  window: { readonly id: string; readonly label: string },
  model: string,
): boolean {
  const words = `${window.id} ${window.label}`
    .toLowerCase()
    .split(/[^a-z0-9]+/u)
    .filter((word) => word.length >= 3 && !/^\d+$/u.test(word) && !GENERIC_WINDOW_WORDS.has(word));
  const slug = model.toLowerCase();
  return words.every((word) => slug.includes(word));
}

/** A usage window counts as used up from this percentage. */
const WINDOW_FULL_PERCENT = 99.5;

/**
 * Why a provider cannot take new chats for `model` right now, or undefined. Looks
 * at the provider's own report: not installed, switched off, signed out, or a
 * usage window used up that has not reset yet.
 */
export function providerBlock(
  provider: ServerProvider | undefined,
  model: string,
  nowMs: number,
): { readonly until?: number; readonly reason: string } | undefined {
  if (!provider) return { reason: "is not set up" };
  if (!provider.enabled) return { reason: "is switched off" };
  if (provider.availability === "unavailable" || !provider.installed) {
    return { reason: "is not installed" };
  }
  if (provider.auth.status === "unauthenticated") return { reason: "is signed out" };
  let until: number | undefined;
  for (const window of provider.usageLimits?.windows ?? []) {
    if (window.usedPercent < WINDOW_FULL_PERCENT || window.resetsAt === undefined) continue;
    const resetsAt = Date.parse(window.resetsAt);
    if (!(resetsAt > nowMs) || !windowCoversModel(window, model)) continue;
    until = Math.max(until ?? 0, resetsAt);
  }
  return until === undefined ? undefined : { until, reason: "is out of usage" };
}

export interface ProviderUsageReport {
  readonly checkedAt?: string;
  readonly windows: ReadonlyArray<{
    readonly label: string;
    readonly kind: "session" | "weekly" | "monthly" | "other";
    readonly usedPercent: number;
    readonly resetsAt?: string;
  }>;
  readonly status: "available" | "limited" | "unknown";
  readonly limitedUntil?: string;
  readonly reason?: string;
}

/**
 * The provider-level usage summary shown to outside agents. Model-family windows
 * are left out here (they cover only some models); per-model limits come from
 * `providerBlock` for each model.
 */
export function providerUsageReport(provider: ServerProvider, nowMs: number): ProviderUsageReport {
  const limits = provider.usageLimits;
  const windows = (limits?.windows ?? []).map((window) => ({
    label: window.label,
    kind: window.kind,
    usedPercent: window.usedPercent,
    ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }),
  }));
  const base = {
    ...(limits === undefined ? {} : { checkedAt: limits.checkedAt }),
    windows,
  };
  const block = providerBlock(provider, "", nowMs);
  if (block?.until !== undefined) {
    return {
      ...base,
      status: "limited",
      limitedUntil: DateTime.formatIso(DateTime.makeUnsafe(block.until)),
      reason: block.reason,
    };
  }
  if (block !== undefined) return { ...base, status: "unknown", reason: block.reason };
  if (limits === undefined || limits.unavailable !== undefined || windows.length === 0) {
    return {
      ...base,
      status: "unknown",
      reason: limits?.unavailable?.message ?? "does not report usage",
    };
  }
  return { ...base, status: "available" };
}
