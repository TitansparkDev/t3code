import { describe, expect, it } from "vite-plus/test";

import { directQuotaGroups, parseAntigravityUsage } from "./AntigravityQuota.ts";

describe("parseAntigravityUsage", () => {
  it("maps the direct Google quota summary into separate Gemini and Claude/GPT windows", () => {
    const result = directQuotaGroups({
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
    });

    expect(result).toEqual({
      groups: [
        {
          key: "gemini",
          displayName: "Gemini",
          windows: [
            {
              id: "gemini-weekly",
              label: "Weekly",
              usedPercent: 28,
              windowDurationMins: 10_080,
              resetsAt: "2026-09-15T00:00:00Z",
            },
          ],
        },
        {
          key: "claude-gpt",
          displayName: "Claude & GPT",
          windows: [
            { id: "claude-gpt-5h", label: "5-hour", usedPercent: 59, windowDurationMins: 300 },
            {
              id: "claude-gpt-weekly",
              label: "Weekly",
              usedPercent: 12,
              windowDurationMins: 10_080,
            },
          ],
        },
      ],
    });
  });

  it("reads the structured usage response and keeps the two quota groups", () => {
    const result = parseAntigravityUsage(
      JSON.stringify({
        response: "ignored",
        command: {
          data: {
            groups: [
              {
                name: "Gemini Models",
                buckets: [
                  {
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0.91,
                    reset_time: "2026-09-11T00:33:37Z",
                  },
                  {
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    remaining_fraction: 0.93,
                    reset_time: "2026-09-05T13:31:09Z",
                  },
                ],
              },
              {
                name: "Claude and GPT models",
                buckets: [
                  {
                    name: "Weekly Limit Remaining",
                    window: "weekly",
                    remaining_fraction: 0,
                    reset_time: "2026-09-09T00:59:57Z",
                  },
                  {
                    name: "Five Hour Limit Remaining",
                    window: "5h",
                    disabled: true,
                  },
                ],
              },
            ],
          },
        },
      }),
    );

    expect(result).toEqual({
      groups: [
        {
          key: "gemini",
          displayName: "Gemini Models",
          windows: [
            {
              label: "Weekly Limit",
              usedPercent: 9,
              windowDurationMins: 10_080,
              resetsAt: "2026-09-11T00:33:37Z",
            },
            {
              label: "Five Hour Limit",
              usedPercent: 7,
              windowDurationMins: 300,
              resetsAt: "2026-09-05T13:31:09Z",
            },
          ],
        },
        {
          key: "claude-gpt",
          displayName: "Claude and GPT models",
          windows: [
            {
              label: "Weekly Limit",
              usedPercent: 100,
              windowDurationMins: 10_080,
              resetsAt: "2026-09-09T00:59:57Z",
            },
          ],
        },
      ],
    });
  });

  it("accepts the older tab-separated output", () => {
    const result = parseAntigravityUsage(
      [
        "Gemini Models\tWeekly Limit Remaining\t91%\t2026-09-11T00:33:37Z",
        "Gemini Models\tFive Hour Limit Remaining\t93%\t2026-09-05T13:31:09Z",
      ].join("\n"),
    );

    expect(result?.groups[0]?.windows.map((window) => window.usedPercent)).toEqual([9, 7]);
  });
});
