import { describe, expect, it } from "@effect/vitest";

import type { ProviderInstanceId, ProviderRuntimeEvent } from "@t3tools/contracts";

import {
  applyQuotaEvent,
  classifyQuotaError,
  earliestReset,
  emptyQuotaState,
  forgetQuota,
  isQuotaSnapshotStale,
  isRateLimited,
  QUOTA_SNAPSHOT_STALE_AFTER_MS,
} from "./quotaReducer.ts";
import { normalizeCodexRateLimits } from "./normalizeRateLimits.ts";

const instanceId = "codex-1" as ProviderInstanceId;
const now = Date.parse("2026-08-14T12:00:00.000Z");
const observedAt = "2026-08-14T12:00:00.000Z";

function rateLimitEvent(snapshot: Record<string, unknown>): ProviderRuntimeEvent {
  return {
    type: "account.rate-limits.updated",
    payload: { rateLimits: { rateLimits: snapshot } },
  } as unknown as ProviderRuntimeEvent;
}

const codexEvent = rateLimitEvent({
  primary: { usedPercent: 40, windowDurationMins: 300 },
  secondary: { usedPercent: 82, windowDurationMins: 10080 },
});

const antigravityEvent = rateLimitEvent({
  pools: [
    {
      id: "gemini",
      name: "Gemini",
      windows: [{ usedPercent: 25, windowDurationMins: 300 }],
    },
    {
      id: "claude-gpt",
      name: "Claude and GPT",
      windows: [{ usedPercent: 75, windowDurationMins: 10080 }],
    },
  ],
});

describe("applyQuotaEvent", () => {
  it("records a snapshot for a known driver", () => {
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: codexEvent,
      observedAt,
    });
    expect(state.get(instanceId)?.groups[0]?.windows).toHaveLength(2);
  });

  it("records Antigravity's independent quota pools", () => {
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: "antigravity-1" as ProviderInstanceId,
      driverKind: "antigravity",
      event: antigravityEvent,
      observedAt,
    });
    expect(state.get("antigravity-1" as ProviderInstanceId)?.groups).toHaveLength(2);
  });

  it("ignores events that are not quota events", () => {
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: { type: "turn.completed", payload: {} } as unknown as ProviderRuntimeEvent,
      observedAt,
    });
    expect(state).toBe(emptyQuotaState);
  });

  it("returns the same state object when nothing changed, so callers can skip a publish", () => {
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "opencode",
      event: codexEvent,
      observedAt,
    });
    expect(state).toBe(emptyQuotaState);
  });

  it("refuses to guess at an unknown driver's payload", () => {
    // A fork's driver, or a newer release's. Guessing produces a confident
    // wrong number, which is worse than showing nothing.
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "someFutureDriver",
      event: codexEvent,
      observedAt,
    });
    expect(state.size).toBe(0);
  });

  it("merges a later sparse update onto the earlier one", () => {
    const first = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: codexEvent,
      observedAt,
    });
    const second = applyQuotaEvent(first, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: rateLimitEvent({ primary: { usedPercent: 61, windowDurationMins: 300 } }),
      observedAt: "2026-08-14T12:30:00.000Z",
    });
    const windows = second.get(instanceId)!.groups[0]!.windows;
    expect(windows).toHaveLength(2);
    expect(windows.find((w) => w.kind === "short")?.usedPercent).toBe(61);
    expect(windows.find((w) => w.kind === "long")?.usedPercent).toBe(82);
  });

  it("keeps instances independent", () => {
    const other = "codex-2" as ProviderInstanceId;
    let state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: codexEvent,
      observedAt,
    });
    state = applyQuotaEvent(state, {
      providerInstanceId: other,
      driverKind: "codex",
      event: rateLimitEvent({ primary: { usedPercent: 5, windowDurationMins: 300 } }),
      observedAt,
    });
    expect(state.get(instanceId)?.groups[0]?.windows[0]?.usedPercent).toBe(40);
    expect(state.get(other)?.groups[0]?.windows[0]?.usedPercent).toBe(5);
  });

  it("replaces Antigravity point-in-time telemetry instead of retaining a vanished pool", () => {
    const agy = "antigravity-1" as ProviderInstanceId;
    const first = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: agy,
      driverKind: "antigravity",
      event: antigravityEvent,
      observedAt,
    });
    const second = applyQuotaEvent(first, {
      providerInstanceId: agy,
      driverKind: "antigravity",
      event: rateLimitEvent({
        pools: [
          {
            id: "gemini",
            name: "Gemini",
            windows: [{ usedPercent: 30, windowDurationMins: 300 }],
          },
        ],
      }),
      observedAt: "2026-08-14T12:30:00.000Z",
    });

    expect(second.get(agy)?.groups.map((group) => group.key)).toEqual(["gemini"]);
    expect(second.get(agy)?.groups[0]?.windows[0]?.usedPercent).toBe(30);
  });

  it("does not refresh missing Claude windows with a newer observation timestamp", () => {
    const claude = "claude-1" as ProviderInstanceId;
    const first = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: claude,
      driverKind: "claudeAgent",
      event: rateLimitEvent({
        five_hour: { usedPercent: 20 },
        weekly: { usedPercent: 70 },
      }),
      observedAt,
    });
    const second = applyQuotaEvent(first, {
      providerInstanceId: claude,
      driverKind: "claudeAgent",
      event: rateLimitEvent({ five_hour: { usedPercent: 25 } }),
      observedAt: "2026-08-14T12:30:00.000Z",
    });

    const windows = second.get(claude)?.groups[0]?.windows ?? [];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.usedPercent).toBe(25);
    expect(windows.some((window) => window.kind === "long")).toBe(false);
  });
});

describe("forgetQuota", () => {
  it("drops an instance so a snapshot cannot outlive the account it described", () => {
    const state = applyQuotaEvent(emptyQuotaState, {
      providerInstanceId: instanceId,
      driverKind: "codex",
      event: codexEvent,
      observedAt,
    });
    expect(forgetQuota(state, instanceId).size).toBe(0);
  });

  it("is identity for an unknown instance", () => {
    expect(forgetQuota(emptyQuotaState, instanceId)).toBe(emptyQuotaState);
  });
});

describe("isRateLimited", () => {
  const limited = normalizeCodexRateLimits({
    providerInstanceId: instanceId,
    observedAt,
    payload: {
      rateLimits: {
        rateLimits: {
          rateLimitReachedType: "rate_limit_reached",
          primary: {
            usedPercent: 100,
            windowDurationMins: 300,
            resetsAt: Math.floor(Date.parse("2026-08-14T17:00:00.000Z") / 1000),
          },
        },
      },
    },
  })!;

  it("is true while the limit is live and the reset is still ahead", () => {
    expect(isRateLimited(limited, now)).toBe(true);
  });

  it("is false once the published reset time has passed", () => {
    // The account-stuck bug: the window rolled over, but the provider has had
    // no reason to publish anything since, so nothing cleared the flag.
    expect(isRateLimited(limited, Date.parse("2026-08-14T17:00:01.000Z"))).toBe(false);
  });

  it("is false for a stale snapshot even with no reset time", () => {
    const noReset = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        rateLimits: { rateLimits: { rateLimitReachedType: "rate_limit_reached" } },
      },
    })!;
    expect(isRateLimited(noReset, now)).toBe(true);
    expect(isRateLimited(noReset, now + QUOTA_SNAPSHOT_STALE_AFTER_MS + 1)).toBe(false);
  });

  it("is false when no limit was reported, whatever the percentage", () => {
    const busy = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        rateLimits: { rateLimits: { primary: { usedPercent: 100, windowDurationMins: 300 } } },
      },
    })!;
    // 100% used is not the same fact as "the provider refused the work".
    expect(isRateLimited(busy, now)).toBe(false);
  });

  it("is false for a missing snapshot", () => {
    expect(isRateLimited(undefined, now)).toBe(false);
  });
});

describe("isQuotaSnapshotStale", () => {
  const fresh = normalizeCodexRateLimits({
    providerInstanceId: instanceId,
    observedAt,
    payload: {
      rateLimits: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } },
    },
  })!;

  it("is false inside the window", () => {
    expect(isQuotaSnapshotStale(fresh, now + 60_000)).toBe(false);
  });

  it("is true past it", () => {
    expect(isQuotaSnapshotStale(fresh, now + QUOTA_SNAPSHOT_STALE_AFTER_MS + 1)).toBe(true);
  });

  it("treats an unparseable timestamp as stale", () => {
    expect(isQuotaSnapshotStale({ ...fresh, observedAt: "not a date" }, now)).toBe(true);
  });
});

describe("earliestReset", () => {
  it("finds the soonest reset across windows", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        rateLimits: {
          rateLimits: {
            primary: {
              usedPercent: 10,
              windowDurationMins: 300,
              resetsAt: Math.floor(Date.parse("2026-08-14T17:00:00.000Z") / 1000),
            },
            secondary: {
              usedPercent: 80,
              windowDurationMins: 10080,
              resetsAt: Math.floor(Date.parse("2026-08-18T00:00:00.000Z") / 1000),
            },
          },
        },
      },
    })!;
    expect(earliestReset(snapshot)).toBe(Date.parse("2026-08-14T17:00:00.000Z"));
  });

  it("is undefined when no window published one", () => {
    const snapshot = normalizeCodexRateLimits({
      providerInstanceId: instanceId,
      observedAt,
      payload: {
        rateLimits: { rateLimits: { primary: { usedPercent: 10, windowDurationMins: 300 } } },
      },
    })!;
    expect(earliestReset(snapshot)).toBeUndefined();
  });
});

describe("classifyQuotaError", () => {
  it("classifies HTTP status codes", () => {
    expect(classifyQuotaError({ status: 401 })).toBe("unauthorized");
    expect(classifyQuotaError({ status: 403 })).toBe("forbidden");
    expect(classifyQuotaError({ status: 429 })).toBe("rate_limited");
    expect(classifyQuotaError({ status: 500 })).toBe("unavailable");
    expect(classifyQuotaError({ status: 503 })).toBe("unavailable");
  });

  it("classifies Effect error tags", () => {
    expect(classifyQuotaError({ _tag: "RateLimitExceeded" })).toBe("rate_limited");
    expect(classifyQuotaError({ _tag: "TimeoutException" })).toBe("timeout");
    expect(classifyQuotaError({ _tag: "Unauthorized" })).toBe("unauthorized");
    expect(classifyQuotaError({ _tag: "Forbidden" })).toBe("forbidden");
  });

  it("classifies error message contents", () => {
    expect(classifyQuotaError(new Error("Request timed out after 15 seconds"))).toBe("timeout");
    expect(classifyQuotaError(new Error("fetch failed: ECONNREFUSED 127.0.0.1:45123"))).toBe(
      "network_error",
    );
    expect(classifyQuotaError(new Error("Unexpected token in JSON at position 0"))).toBe(
      "parse_error",
    );
    expect(classifyQuotaError(new Error("Process exited with code 1"))).toBe("process_error");
    expect(classifyQuotaError(new Error("Too many requests"))).toBe("rate_limited");
    expect(classifyQuotaError("Unknown error occurred")).toBe("unavailable");
  });
});
