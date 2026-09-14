import type { IsoDateTime } from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

const FALLBACK_RETRY_DELAY_MS = 5 * 60 * 1_000;
const PROVIDER_RETRY_CUSHION_MS = 2_000;

export function initialUsageLimitResumeAt(
  providerRetryAt: IsoDateTime | undefined,
  nowMs = DateTime.toEpochMillis(DateTime.nowUnsafe()),
): IsoDateTime {
  const retryAtMs = providerRetryAt === undefined ? Number.NaN : Date.parse(providerRetryAt);
  const resumeAtMs =
    Number.isFinite(retryAtMs) && retryAtMs > nowMs
      ? retryAtMs + PROVIDER_RETRY_CUSHION_MS
      : nowMs + FALLBACK_RETRY_DELAY_MS;
  return DateTime.formatIso(DateTime.makeUnsafe(resumeAtMs)) as IsoDateTime;
}
