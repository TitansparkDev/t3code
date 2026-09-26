import { describe, expect, it } from "@effect/vitest";

import type { ProviderInstanceId } from "@t3tools/contracts";

import {
  isoFromEpochSeconds,
  isoFromEpochTimestamp,
  mergeQuotaSnapshots,
  normalizeAntigravityRateLimits,
  normalizeClaudeRateLimits,
  normalizeCodexRateLimits,
} from "./normalizeRateLimits.ts";

const instanceId = "codex-1" as ProviderInstanceId;
const observedAt = "2026-08-14T12:00:00.000Z";

/** Shape of a real `account/rateLimits/updated` notification from Codex. */
function codexPayload(snapshot: Record<string, unknown>) {
  return { rateLimits: { rateLimits: snapshot } };
}

describe("isoFromEpochSeconds", () => {
  it("reads epoch seconds", () => {
    expect(isoFromEpochSeconds(1_775_000_000)).toBe("2026-03-31T23:33:20.000Z");
  });

  it("rejects milliseconds rather than landing in the year 57000", () => {
    expect(isoFromEpochSeconds(1_775_000_000_000)).toBeUndefined();
  });

  it("rejects non-numbers and implausible values", () => {
    expect(isoFromEpochSeconds("soon")).toBeUndefined();
    expect(isoFromEpochSeconds(0)).toBeUndefined();
    expect(isoFromEpochSeconds(Number.NaN)).toBeUndefined();
  });
});

describe("isoFromEpochTimestamp", () => {
  it("converts epoch seconds properly", () => {
    expect(isoFromEpochTimestamp(1_775_000_000)).toBe("2026-03-31T23:33:20.000Z");
  });

  it("converts epoch milliseconds properly", () => {
    expect(isoFromEpochTimestamp(1_775_000_000_000)).toBe("2026-03-31T23:33:20.000Z");
  });

  it("accepts string-encoded epoch timestamps", () => {
    expect(isoFromEpochTimestamp("1775000000")).toBe("2026-03-31T23:33:20.000Z");
    expect(isoFromEpochTimestamp("1775000000000")).toBe("2026-03-31T23:33:20.000Z");
  });

  it("accepts ISO date strings directly", () => {
    expect(isoFromEpochTimestamp("2026-03-31T23:33:20.000Z")).toBe("2026-03-31T23:33:20.000Z");
  });

  it("rejects invalid or out of bound values", () => {
    expect(isoFromEpochTimestamp("invalid")).toBeUndefined();
    expect(isoFromEpochTimestamp(0)).toBeUndefined();
    expect(isoFromEpochTimestamp(null)).toBeUndefined();
  });
});

describe("normalizeCodexRateLimits", () => {
  it("reads the snake-case snapshot stored in Codex transcripts", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        limit_name: "ChatGPT Plus",
        plan_type: "plus",
        primary: { used_percent: 12, resets_at: 1_775_000_000, window_minutes: 300 },
        secondary: { used_percent: 34, window_minutes: 10080 },
      },
    });

    expect(snapshot?.planType).toBe("plus");
    expect(snapshot?.groups[0]?.displayName).toBe("ChatGPT Plus");
    expect(snapshot?.groups[0]?.windows.map((window) => window.usedPercent)).toEqual([12, 34]);
  });

  it("reads both windows and classifies them by duration", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        limitName: "ChatGPT Pro",
        planType: "pro",
        primary: { usedPercent: 42, resetsAt: 1_775_000_000, windowDurationMins: 300 },
        secondary: { usedPercent: 90, resetsAt: 1_775_400_000, windowDurationMins: 10080 },
      }),
    });

    expect(snapshot).toBeDefined();
    expect(snapshot?.planType).toBe("pro");
    expect(snapshot?.source).toBe("provider-event");
    expect(snapshot?.groups[0]?.displayName).toBe("ChatGPT Pro");
    expect(snapshot?.groups[0]?.windows).toEqual([
      {
        kind: "short",
        usedPercent: 42,
        label: undefined,
        resetsAt: "2026-03-31T23:33:20.000Z",
        windowDurationMins: 300,
      },
      {
        kind: "long",
        usedPercent: 90,
        label: undefined,
        resetsAt: "2026-04-05T14:40:00.000Z",
        windowDurationMins: 10080,
      },
    ]);
  });

  it("accepts the payload already unwrapped one level", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        rateLimits: {
          primary: { usedPercent: 25, windowDurationMins: 300 },
        },
      },
    });
    expect(snapshot?.groups[0]?.windows).toHaveLength(1);
    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(25);
  });

  it("accepts the payload with primary directly on root", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        primary: { usedPercent: 25, windowDurationMins: 300 },
      },
    });
    expect(snapshot?.groups[0]?.windows).toHaveLength(1);
    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(25);
  });

  it("parses additionalRateLimits as an array", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        additionalRateLimits: [
          { usedPercent: 10, windowDurationMins: 60 },
          { usedPercent: 20, windowDurationMins: 1440 },
        ],
      }),
    });
    expect(snapshot?.groups[0]?.windows).toHaveLength(2);
    expect(snapshot?.groups[0]?.windows[0]?.label).toBe("Additional limit 1");
    expect(snapshot?.groups[0]?.windows[1]?.label).toBe("Additional limit 2");
  });

  it("parses additionalRateLimits as a record map", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        additionalRateLimits: {
          "o1-preview": { usedPercent: 50, windowDurationMins: 1440 },
        },
      }),
    });
    expect(snapshot?.groups[0]?.windows).toHaveLength(1);
    expect(snapshot?.groups[0]?.windows[0]?.label).toBe("o1-preview");
  });

  it("keeps a window that has no reset time instead of inventing one", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        primary: { usedPercent: 50, windowDurationMins: 300 },
      }),
    });

    expect(snapshot?.groups[0]?.windows[0]?.resetsAt).toBeUndefined();
  });

  it("leaves an undurated window unknown rather than guessing by position", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        primary: { usedPercent: 50 },
      }),
    });

    expect(snapshot?.groups[0]?.windows[0]?.kind).toBe("unknown");
    expect(snapshot?.groups[0]?.windows[0]?.windowDurationMins).toBeUndefined();
  });

  it("clamps an over-100 reading without discarding it", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        primary: { usedPercent: 101, windowDurationMins: 300 },
      }),
    });

    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(100);
  });

  it("carries the limit-reached reason", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, windowDurationMins: 300 },
      }),
    });

    expect(snapshot?.limitReached).toBe("rate_limit_reached");
  });

  it("returns undefined for an unrecognized payload rather than a zeroed row", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: { unrelatedEvent: { foo: "bar" } },
    });

    expect(snapshot).toBeUndefined();
  });

  it("drops a window with no percentage instead of showing it at zero", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        primary: { windowDurationMins: 300 },
      }),
    });

    expect(snapshot).toBeUndefined();
  });
});

describe("normalizeClaudeRateLimits", () => {
  it("reads the full-window SDK usage response", () => {
    const snapshot = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt,
      payload: {
        rateLimits: {
          subscription_type: "max",
          rate_limits: {
            five_hour: { utilization: 22, resets_at: "2026-08-24T05:00:00.000Z" },
            seven_day: { utilization: 48, resets_at: "2026-08-30T00:00:00.000Z" },
          },
        },
      },
    });

    expect(snapshot?.planType).toBe("max");
    expect(snapshot?.groups[0]?.windows).toEqual([
      {
        id: "claude:five-hour",
        kind: "short",
        usedPercent: 22,
        label: "5-hour limit",
        resetsAt: "2026-08-24T05:00:00.000Z",
        windowDurationMins: 300,
      },
      {
        id: "claude:seven-day",
        kind: "long",
        usedPercent: 48,
        label: "Weekly limit",
        resetsAt: "2026-08-30T00:00:00.000Z",
        windowDurationMins: 10_080,
      },
    ]);
  });

  it("reads mid-turn SDK rate_limit_event with rate_limit_info and assigns canonical ID", () => {
    const snapshot = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt,
      payload: {
        rate_limit_info: {
          rate_limit_type: "five_hour",
          utilization: 0.35,
          resets_at: "2026-08-24T18:00:00.000Z",
        },
      },
    });

    expect(snapshot?.groups[0]?.windows).toHaveLength(1);
    expect(snapshot?.groups[0]?.windows[0]).toMatchObject({
      id: "claude:five-hour",
      kind: "short",
      label: "5-hour limit",
      usedPercent: 35,
      resetsAt: "2026-08-24T18:00:00.000Z",
      windowDurationMins: 300,
    });
  });

  it("reads model-scoped weekly limits (Opus, Sonnet)", () => {
    const snapshot = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt,
      payload: {
        seven_day_opus: { usedPercent: 78, windowDurationMins: 10_080 },
        seven_day_sonnet: { usedPercent: 42, windowDurationMins: 10_080 },
      },
    });

    expect(snapshot?.groups[0]?.windows).toHaveLength(2);
    expect(
      snapshot?.groups[0]?.windows.find((w) => w.label === "Opus weekly limit")?.usedPercent,
    ).toBe(78);
    expect(
      snapshot?.groups[0]?.windows.find((w) => w.label === "Sonnet weekly limit")?.usedPercent,
    ).toBe(42);
  });

  it("reads duration-tagged windows", () => {
    const snapshot = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt,
      payload: {
        rateLimits: {
          five_hour: { usedPercent: 12, resetsAt: 1_775_000_000, windowDurationMins: 300 },
          weekly: { usedPercent: 88, resetsAt: 1_775_400_000, windowDurationMins: 10080 },
        },
      },
    });

    expect(snapshot?.groups[0]?.windows).toHaveLength(2);
    expect(snapshot?.groups[0]?.windows[0]?.label).toBe("5-hour limit");
    expect(snapshot?.groups[0]?.windows[1]?.kind).toBe("long");
  });

  it("reads a plain list of windows", () => {
    const snapshot = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt,
      payload: { windows: [{ usedPercent: 30, windowDurationMins: 300 }] },
    });
    expect(snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(30);
  });

  it("returns undefined on an unrecognized shape so the row reads 'not exposed'", () => {
    expect(
      normalizeClaudeRateLimits({
        providerInstanceId: "claude-1" as ProviderInstanceId,
        observedAt,
        payload: { type: "rate_limit_event", somethingNew: { pct: 50 } },
      }),
    ).toBeUndefined();
  });
});

describe("normalizeAntigravityRateLimits", () => {
  it("keeps separate provider pools and classifies their published windows", () => {
    const snapshot = normalizeAntigravityRateLimits({
      providerInstanceId: "antigravity-1" as ProviderInstanceId,
      observedAt,
      payload: {
        rate_limits: {
          plan_type: "pro",
          pools: [
            {
              id: "gemini",
              name: "Gemini",
              windows: [
                {
                  id: "gemini-5h",
                  window: "5h",
                  used_percent: 18,
                  resets_at: "2026-08-14T17:00:00.000Z",
                },
                {
                  id: "gemini-weekly",
                  window: "weekly",
                  used_percent: 44,
                  resets_at: "2026-08-20T00:00:00.000Z",
                },
              ],
            },
            {
              id: "claude-gpt",
              name: "Claude & GPT",
              windows: [
                {
                  id: "claude-weekly",
                  window: "weekly",
                  used_percent: 91,
                  resets_at: "2026-08-18T12:00:00.000Z",
                },
              ],
            },
          ],
        },
      },
    });

    expect(snapshot?.planType).toBe("pro");
    expect(snapshot?.source).toBe("antigravity-quota-summary");
    expect(snapshot?.groups.map((group) => group.key)).toEqual(["gemini", "claude-gpt"]);
    expect(snapshot?.groups[0]?.windows.map((window) => window.kind)).toEqual(["short", "long"]);
    expect(snapshot?.groups[1]?.windows.map((window) => window.kind)).toEqual(["long"]);
  });

  it("rejects prompt credits and flow credits so they never become subscription windows", () => {
    const snapshot = normalizeAntigravityRateLimits({
      providerInstanceId: "antigravity-1" as ProviderInstanceId,
      observedAt,
      payload: {
        rate_limits: {
          pools: [
            {
              id: "credits",
              name: "Monthly Prompt Credits",
              windows: [{ used_percent: 15, window: "monthly" }],
            },
            {
              id: "gemini",
              name: "Gemini",
              windows: [{ used_percent: 25, window: "5h" }],
            },
          ],
        },
      },
    });

    expect(snapshot?.groups).toHaveLength(1);
    expect(snapshot?.groups[0]?.key).toBe("gemini");
  });

  it("does not turn an unrecognized bridge payload into quota", () => {
    expect(
      normalizeAntigravityRateLimits({
        providerInstanceId: "antigravity-1" as ProviderInstanceId,
        observedAt,
        payload: { status: "ok", code: 0 },
      }),
    ).toBeUndefined();
  });

  it("converts Antigravity structured remaining fractions and keeps full windows", () => {
    const snapshot = normalizeAntigravityRateLimits({
      providerInstanceId: "antigravity-1" as ProviderInstanceId,
      observedAt,
      payload: {
        groups: [
          {
            displayName: "Gemini models",
            buckets: [
              {
                bucketId: "gemini-weekly",
                window: "weekly",
                remainingFraction: 0.72,
                resetTime: "2026-09-15T00:00:00Z",
              },
            ],
          },
          {
            displayName: "Claude and GPT models",
            buckets: [
              {
                bucketId: "claude-gpt-5h",
                window: "5h",
                remainingFraction: 0.41,
              },
              {
                bucketId: "claude-gpt-weekly",
                window: "weekly",
                remainingFraction: 0.88,
              },
            ],
          },
        ],
      },
    });

    expect(snapshot?.source).toBe("antigravity-quota-summary");
    expect(snapshot?.groups).toHaveLength(2);

    const gemini = snapshot?.groups.find((g) => g.key === "gemini");
    expect(gemini?.displayName).toBe("Gemini");
    expect(gemini?.windows).toEqual([
      {
        id: "gemini-weekly",
        label: "Weekly",
        usedPercent: 28,
        windowDurationMins: 10_080,
        resetsAt: "2026-09-15T00:00:00.000Z",
        kind: "long",
      },
    ]);

    const claudeGpt = snapshot?.groups.find((g) => g.key === "claude-gpt");
    expect(claudeGpt?.displayName).toBe("Claude & GPT");
    expect(claudeGpt?.windows).toEqual([
      {
        id: "claude-gpt-5h",
        label: "5-hour",
        usedPercent: 59,
        windowDurationMins: 300,
        kind: "short",
      },
      {
        id: "claude-gpt-weekly",
        label: "Weekly",
        usedPercent: 12,
        windowDurationMins: 10_080,
        kind: "long",
      },
    ]);
  });

  it("normalizes per-model fallback buckets by limiting bucket and marks source", () => {
    const snapshot = normalizeAntigravityRateLimits({
      providerInstanceId: "antigravity-1" as ProviderInstanceId,
      observedAt,
      payload: {
        modelGroups: [
          {
            name: "gemini-2.5-flash",
            buckets: [
              {
                window: "5h",
                remainingFraction: 0.8,
                resetTime: "2026-09-10T08:00:00Z",
              },
            ],
          },
          {
            name: "gemini-2.5-pro",
            buckets: [
              {
                window: "5h",
                remainingFraction: 0.55,
                resetTime: "2026-09-10T10:00:00Z",
              },
              {
                window: "weekly",
                remainingFraction: 0.7,
                resetTime: "2026-09-15T00:00:00Z",
              },
            ],
          },
          {
            name: "claude-3-7-sonnet",
            buckets: [
              {
                window: "5h",
                remainingFraction: 0.4,
                resetTime: "2026-09-10T09:00:00Z",
              },
            ],
          },
          {
            name: "internal-custom-sandbox",
            buckets: [
              {
                window: "5h",
                remainingFraction: 0.1,
              },
            ],
          },
        ],
      },
    });

    expect(snapshot?.source).toBe("antigravity-model-fallback");
    expect(snapshot?.groups.map((group) => group.key)).toEqual(["gemini", "claude-gpt"]);

    const gemini = snapshot?.groups.find((g) => g.key === "gemini");
    expect(gemini?.displayName).toBe("Gemini Models");
    expect(gemini?.windows[0]).toMatchObject({
      kind: "short",
      usedPercent: 45,
      resetsAt: "2026-09-10T10:00:00.000Z",
    });

    const claudeGpt = snapshot?.groups.find((g) => g.key === "claude-gpt");
    expect(claudeGpt?.displayName).toBe("Claude & GPT models");
    expect(claudeGpt?.windows[0]).toMatchObject({
      kind: "short",
      usedPercent: 60,
      resetsAt: "2026-09-10T09:00:00.000Z",
    });
  });
});

describe("mergeQuotaSnapshots", () => {
  const base = normalizeCodexRateLimits({
    providerInstanceId: instanceId,
    observedAt,
    payload: codexPayload({
      primary: { usedPercent: 40, windowDurationMins: 300 },
      secondary: { usedPercent: 80, windowDurationMins: 10080 },
    }),
  })!;

  it("does not let a sparse update erase the window it omitted", () => {
    const sparse = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt: "2026-08-14T12:05:00.000Z",
      payload: codexPayload({ primary: { usedPercent: 55, windowDurationMins: 300 } }),
    })!;

    const merged = mergeQuotaSnapshots(base, sparse);
    const windows = merged.groups[0]!.windows;
    expect(windows).toHaveLength(2);
    expect(windows.find((w) => w.kind === "short")?.usedPercent).toBe(55);
    expect(windows.find((w) => w.kind === "long")?.usedPercent).toBe(80);
  });

  it("sparse Claude update: merging session 5h window into previous snapshot with weekly window retains weekly window", () => {
    const fullClaude = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt: "2026-08-14T12:00:00.000Z",
      payload: {
        rateLimits: {
          rate_limits: {
            five_hour: { utilization: 20, resets_at: "2026-08-14T17:00:00.000Z" },
            seven_day: { utilization: 60, resets_at: "2026-08-20T00:00:00.000Z" },
          },
        },
      },
    })!;

    const sparseMidTurn = normalizeClaudeRateLimits({
      providerInstanceId: "claude-1" as ProviderInstanceId,
      observedAt: "2026-08-14T12:30:00.000Z",
      payload: {
        rate_limit_info: {
          rate_limit_type: "five_hour",
          utilization: 0.35,
          resets_at: "2026-08-14T17:00:00.000Z",
        },
      },
    })!;

    const merged = mergeQuotaSnapshots(fullClaude, sparseMidTurn);
    const windows = merged.groups[0]!.windows;
    expect(windows).toHaveLength(2);
    expect(windows.find((w) => w.kind === "short")?.usedPercent).toBe(35);
    expect(windows.find((w) => w.kind === "long")?.usedPercent).toBe(60);
  });

  it("preserves resetCredits, retryAfterMs, and retryAt on snapshot merge", () => {
    const initial = {
      ...base,
      resetCredits: { availableCount: 10 },
    };
    const incoming = {
      ...base,
      observedAt: "2026-08-14T12:10:00.000Z",
      retryAfterMs: 30_000,
      retryAt: "2026-08-14T12:10:30.000Z",
    };

    const merged = mergeQuotaSnapshots(initial, incoming);
    expect(merged.resetCredits?.availableCount).toBe(10);
    expect(merged.retryAfterMs).toBe(30_000);
    expect(merged.retryAt).toBe("2026-08-14T12:10:30.000Z");
  });

  it("clears a stale limit-reached rather than carrying it past the reset", () => {
    const limited = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: codexPayload({
        rateLimitReachedType: "rate_limit_reached",
        primary: { usedPercent: 100, windowDurationMins: 300 },
      }),
    })!;
    const recovered = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt: "2026-08-14T17:00:00.000Z",
      payload: codexPayload({ primary: { usedPercent: 3, windowDurationMins: 300 } }),
    })!;

    expect(mergeQuotaSnapshots(limited, recovered).limitReached).toBeUndefined();
  });

  it("replaces wholesale when the instance differs", () => {
    const other = { ...base, providerInstanceId: "codex-2" as ProviderInstanceId };
    expect(mergeQuotaSnapshots(base, other)).toBe(other);
  });

  it("drops older snapshot when incoming observedAt is older than current", () => {
    const older = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt: "2026-08-14T11:00:00.000Z",
      payload: codexPayload({ primary: { usedPercent: 10, windowDurationMins: 300 } }),
    })!;
    expect(mergeQuotaSnapshots(base, older)).toBe(base);
  });
});
