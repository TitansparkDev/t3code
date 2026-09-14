import { describe, expect, it } from "@effect/vitest";

import {
  nextUsageLimitRetryAt,
  providerUsageLimitFromError,
  retryAtFromEpochSeconds,
} from "./usageLimits.ts";

describe("provider usage-limit parsing", () => {
  it("recognizes nested HTTP 429 details and their reset time", () => {
    const result = providerUsageLimitFromError({
      message: "Provider request failed",
      detail: {
        response: {
          status: 429,
          reset_at: "2030-01-02T03:04:05.000Z",
        },
      },
    });

    expect(result).toEqual({ retryAt: "2030-01-02T03:04:05.000Z" });
  });

  it("recognizes usage-limit wording without requiring provider metadata", () => {
    expect(providerUsageLimitFromError({ message: "Quota exhausted" })).toEqual({});
    expect(providerUsageLimitFromError({ message: "Workspace not found" })).toBeNull();
  });

  it("converts provider epoch seconds to an ISO reset time", () => {
    expect(retryAtFromEpochSeconds(1_893_553_200)).toBe("2030-01-02T03:00:00.000Z");
  });

  it("adds a short cushion to provider resets and backs off without one", () => {
    expect(
      nextUsageLimitRetryAt({
        now: "2030-01-02T03:00:00.000Z",
        attempt: 0,
        providerRetryAt: "2030-01-02T03:04:05.000Z",
      }),
    ).toBe("2030-01-02T03:04:07.000Z");
    expect(
      nextUsageLimitRetryAt({
        now: "2030-01-02T03:00:00.000Z",
        attempt: 1,
      }),
    ).toBe("2030-01-02T03:15:00.000Z");
  });
});
