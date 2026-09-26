import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";

import {
  AccountQuotaSnapshot,
  QuotaResetCredits,
  QuotaSource,
  QuotaWindow,
  quotaWindowKindFromDuration,
} from "./quota.ts";
import { ProviderInstanceId } from "./providerInstance.ts";

describe("quota contracts", () => {
  it("decodes QuotaSource with extended sources", () => {
    const decodeSource = Schema.decodeSync(QuotaSource);
    expect(decodeSource("codex-app-server")).toBe("codex-app-server");
    expect(decodeSource("codex-transcript")).toBe("codex-transcript");
    expect(decodeSource("provider-event")).toBe("provider-event");
    expect(decodeSource("antigravity-quota-summary")).toBe("antigravity-quota-summary");
    expect(decodeSource("antigravity-model-fallback")).toBe("antigravity-model-fallback");
  });

  it("decodes AccountQuotaSnapshot with attempt/success timestamps and error classification", () => {
    const decode = Schema.decodeSync(AccountQuotaSnapshot);
    const snapshot = decode({
      providerInstanceId: ProviderInstanceId.make("codex-test"),
      groups: [
        {
          key: "default",
          displayName: "ChatGPT Plus",
          windows: [
            {
              id: "codex:primary:five-hour",
              kind: "short",
              usedPercent: 25,
              resetsAt: "2026-09-24T15:00:00.000Z",
              windowDurationMins: 300,
            },
          ],
        },
      ],
      source: "codex-app-server",
      observedAt: "2026-09-24T12:00:00.000Z",
      lastAttemptAt: "2026-09-24T12:00:00.000Z",
      lastSuccessfulAt: "2026-09-24T12:00:00.000Z",
      errorCode: "rate_limited",
      retryAfterMs: 60000,
      retryAt: "2026-09-24T12:01:00.000Z",
      resetCredits: {
        availableCount: 2,
        nextExpiresAt: "2026-10-01T00:00:00.000Z",
      },
    });

    expect(snapshot.source).toBe("codex-app-server");
    expect(snapshot.lastAttemptAt).toBe("2026-09-24T12:00:00.000Z");
    expect(snapshot.lastSuccessfulAt).toBe("2026-09-24T12:00:00.000Z");
    expect(snapshot.errorCode).toBe("rate_limited");
    expect(snapshot.retryAfterMs).toBe(60000);
    expect(snapshot.retryAt).toBe("2026-09-24T12:01:00.000Z");
    expect(snapshot.resetCredits?.availableCount).toBe(2);
    expect(snapshot.groups[0]?.windows[0]?.id).toBe("codex:primary:five-hour");
  });

  it("determines quotaWindowKind correctly", () => {
    expect(quotaWindowKindFromDuration(300)).toBe("short");
    expect(quotaWindowKindFromDuration(10_080)).toBe("long");
    expect(quotaWindowKindFromDuration(undefined)).toBe("unknown");
    expect(quotaWindowKindFromDuration(0)).toBe("unknown");
    expect(quotaWindowKindFromDuration(-10)).toBe("unknown");
  });
});
