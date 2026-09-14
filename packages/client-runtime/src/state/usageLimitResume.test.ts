import { describe, expect, it } from "@effect/vitest";

import { initialUsageLimitResumeAt } from "./usageLimitResume.ts";

describe("initialUsageLimitResumeAt", () => {
  it("uses the provider reset plus a short cushion", () => {
    expect(
      initialUsageLimitResumeAt("2030-01-02T03:04:05.000Z", Date.parse("2030-01-02T03:00:00.000Z")),
    ).toBe("2030-01-02T03:04:07.000Z");
  });

  it("falls back to a five-minute delay when no future reset is known", () => {
    expect(initialUsageLimitResumeAt(undefined, Date.parse("2030-01-02T03:00:00.000Z"))).toBe(
      "2030-01-02T03:05:00.000Z",
    );
  });
});
