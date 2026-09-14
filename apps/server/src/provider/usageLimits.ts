import type { IsoDateTime } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const USAGE_LIMIT_MESSAGE =
  /(?:usage|rate) limit|quota (?:has been )?(?:exceeded|reached|exhausted)|too many requests|\b429\b|resource[_ ]exhausted|insufficient[_ ]quota/i;
const RETRY_KEYS = new Set(["resetat", "resetsat", "reset_at", "resets_at", "retryat", "retry_at"]);

export interface ProviderUsageLimit {
  readonly retryAt?: IsoDateTime;
}

function absoluteIso(value: unknown): IsoDateTime | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const milliseconds = value < 10_000_000_000 ? value * 1_000 : value;
    return DateTime.formatIso(DateTime.makeUnsafe(milliseconds)) as IsoDateTime;
  }
  if (typeof value !== "string") return undefined;
  const parsed = DateTime.make(value);
  return parsed._tag === "Some" ? (DateTime.formatIso(parsed.value) as IsoDateTime) : undefined;
}

function retryAtFromDetail(value: unknown, depth = 0): IsoDateTime | undefined {
  if (depth > 6 || typeof value !== "object" || value === null) return undefined;
  for (const [key, entry] of Object.entries(value)) {
    if (RETRY_KEYS.has(key.toLowerCase())) {
      const retryAt = absoluteIso(entry);
      if (retryAt) return retryAt;
    }
  }
  for (const entry of Object.values(value)) {
    const retryAt = retryAtFromDetail(entry, depth + 1);
    if (retryAt) return retryAt;
  }
  return undefined;
}

function detailIsUsageLimit(value: unknown, depth = 0): boolean {
  if (depth > 6) return false;
  if (typeof value === "string") return USAGE_LIMIT_MESSAGE.test(value);
  if (typeof value !== "object" || value === null) return false;
  for (const [key, entry] of Object.entries(value)) {
    if (["code", "status", "statuscode", "status_code"].includes(key.toLowerCase())) {
      if (entry === 429 || (typeof entry === "string" && entry.trim() === "429")) return true;
    }
    if (detailIsUsageLimit(entry, depth + 1)) return true;
  }
  return false;
}

export function providerUsageLimitFromError(input: {
  readonly message: string;
  readonly detail?: unknown;
  readonly retryAt?: IsoDateTime;
}): ProviderUsageLimit | null {
  if (!USAGE_LIMIT_MESSAGE.test(input.message) && !detailIsUsageLimit(input.detail)) return null;
  const retryAt = input.retryAt ?? retryAtFromDetail(input.detail);
  return retryAt === undefined ? {} : { retryAt };
}

export function retryAtFromEpochSeconds(value: number | undefined): IsoDateTime | undefined {
  return value === undefined ? undefined : absoluteIso(value);
}

export function nextUsageLimitRetryAt(input: {
  readonly now: IsoDateTime;
  readonly attempt: number;
  readonly providerRetryAt?: IsoDateTime;
}): IsoDateTime {
  const now = DateTime.makeUnsafe(input.now);
  const providerRetryAt = input.providerRetryAt ? DateTime.make(input.providerRetryAt) : undefined;
  if (
    providerRetryAt?._tag === "Some" &&
    DateTime.toEpochMillis(providerRetryAt.value) > DateTime.toEpochMillis(now)
  ) {
    return DateTime.formatIso(DateTime.add(providerRetryAt.value, { seconds: 2 })) as IsoDateTime;
  }
  const minutes = [5, 15, 30, 60][Math.min(Math.max(input.attempt, 0), 3)] ?? 60;
  return DateTime.formatIso(DateTime.add(now, { minutes })) as IsoDateTime;
}
