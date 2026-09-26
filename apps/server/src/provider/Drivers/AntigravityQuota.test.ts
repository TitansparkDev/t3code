import { describe, expect, it } from "vite-plus/test";

import {
  directQuotaGroups,
  discoverLocalAntigravityEndpoint,
  parseAntigravityUsage,
  projectIdFromLoadCodeAssist,
} from "./AntigravityQuota.ts";

describe("parseAntigravityUsage", () => {
  it("uses the provisioned companion project when Google returns one", () => {
    expect(
      projectIdFromLoadCodeAssist({ cloudaicompanionProject: { projectId: "agy-project" } }),
    ).toBe("agy-project");
    expect(projectIdFromLoadCodeAssist({ cloudaicompanionProject: "agy-project" })).toBe(
      "agy-project",
    );
    expect(projectIdFromLoadCodeAssist({ project: "" })).toBeUndefined();
    expect(projectIdFromLoadCodeAssist({ project: "unrelated-project" })).toBeUndefined();
  });

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

  it("keeps duplicate pool windows unique and gives them order-independent IDs", () => {
    const parse = (buckets: ReadonlyArray<Record<string, unknown>>) =>
      directQuotaGroups({
        groups: buckets.map((bucket) => ({ displayName: "Gemini models", buckets: [bucket] })),
      });
    const first = parse([
      { window: "weekly", remainingFraction: 0.8 },
      { window: "weekly", remainingFraction: 0.6 },
    ]);
    const reordered = parse([
      { window: "weekly", remainingFraction: 0.6 },
      { window: "weekly", remainingFraction: 0.8 },
    ]);

    expect(first?.groups[0]?.windows).toEqual([
      {
        id: "gemini-10080",
        label: "Weekly",
        usedPercent: 40,
        windowDurationMins: 10_080,
      },
    ]);
    expect(reordered?.groups[0]?.windows).toEqual(first?.groups[0]?.windows);
  });

  it("rejects ambiguous strings and out-of-range percentages without parsing credits as quota", () => {
    const result = directQuotaGroups({
      quotaManagerState: {
        monthlyPromptCredits: 100,
        availablePromptCredits: 25,
      },
      groups: [
        {
          displayName: "Gemini models",
          buckets: [
            { window: "weekly", remainingFraction: 1.2 },
            { window: "5h", remainingFraction: "0.5" },
            { window: "weekly", remainingPercent: 101 },
            { window: "weekly", usedPercent: "30" },
            { window: "weekly", usedPercent: 35 },
          ],
        },
      ],
    });

    expect(result?.groups[0]?.windows).toEqual([
      {
        id: "gemini-10080",
        label: "Weekly",
        usedPercent: 35,
        windowDurationMins: 10_080,
      },
    ]);
    expect(
      directQuotaGroups({
        quotaManagerState: { monthlyPromptCredits: 100, availablePromptCredits: 25 },
      }),
    ).toBeUndefined();
  });

  it("keeps unfamiliar quota groups distinct instead of collapsing them into claude-gpt", () => {
    const result = directQuotaGroups({
      groups: [
        {
          displayName: "Custom Experimental Models",
          buckets: [
            {
              window: "5h",
              remainingFraction: 0.5,
            },
          ],
        },
      ],
    });

    expect(result?.groups).toEqual([
      {
        key: "custom-experimental-models",
        displayName: "Custom Experimental Models",
        windows: [
          {
            id: "custom-experimental-models-300",
            label: "5-hour",
            usedPercent: 50,
            windowDurationMins: 300,
          },
        ],
      },
    ]);
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

  it("aggregates per-model fallback buckets by limiting bucket and isolates unknown models", () => {
    const result = directQuotaGroups({
      modelGroups: [
        {
          modelId: "gemini-3.8-flash-high",
          quotaBuckets: [
            { window: "5h", remainingFraction: 0.8, resetTime: "2026-09-10T12:00:00Z" },
            { window: "weekly", remainingFraction: 0.7, resetTime: "2026-09-15T00:00:00Z" },
          ],
        },
        {
          modelId: "gemini-3.7-flash-high",
          quotaBuckets: [
            // Limiting for 5h (remaining 0.55 -> 45% used)
            { window: "5h", remainingFraction: 0.55, resetTime: "2026-09-10T10:00:00Z" },
            { window: "weekly", remainingFraction: 0.85, resetTime: "2026-09-16T00:00:00Z" },
          ],
        },
        {
          modelId: "claude-sonnet-4-6",
          quotaBuckets: [
            { window: "5h", remainingFraction: 0.7, resetTime: "2026-09-10T11:00:00Z" },
          ],
        },
        {
          modelId: "gpt-oss-120b-medium",
          quotaBuckets: [
            // Limiting for Claude & GPT 5h (remaining 0.40 -> 60% used)
            { window: "5h", remainingFraction: 0.4, resetTime: "2026-09-10T09:00:00Z" },
          ],
        },
        {
          modelId: "custom-llama-3",
          quotaBuckets: [
            { window: "5h", remainingFraction: 0.1, resetTime: "2026-09-10T08:00:00Z" },
          ],
        },
      ],
    });

    expect(result).toBeDefined();
    expect(result?.source).toBe("antigravity-model-fallback");
    expect(result?.groups.map((g) => g.key)).toEqual(["gemini", "claude-gpt"]);

    const gemini = result?.groups.find((g) => g.key === "gemini");
    const gemini5h = gemini?.windows.find((w) => w.windowDurationMins === 300);
    expect(gemini5h?.usedPercent).toBe(45);
    expect(gemini5h?.resetsAt).toBe("2026-09-10T10:00:00Z");

    const geminiWeekly = gemini?.windows.find((w) => w.windowDurationMins === 10_080);
    expect(geminiWeekly?.usedPercent).toBe(30);
    expect(geminiWeekly?.resetsAt).toBe("2026-09-15T00:00:00Z");

    const claudeGpt = result?.groups.find((g) => g.key === "claude-gpt");
    const claudeGpt5h = claudeGpt?.windows.find((w) => w.windowDurationMins === 300);
    expect(claudeGpt5h?.usedPercent).toBe(60);
    expect(claudeGpt5h?.resetsAt).toBe("2026-09-10T09:00:00Z");
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

describe("discoverLocalAntigravityEndpoint", () => {
  it("discovers port and csrf token from environment variables", () => {
    const endpoint = discoverLocalAntigravityEndpoint({
      ANTIGRAVITY_PORT: "43123",
      ANTIGRAVITY_CSRF_TOKEN: "secret-token-123",
    });

    expect(endpoint).toEqual({
      port: 43123,
      csrfToken: "secret-token-123",
    });
  });

  it("accepts AGY_PORT and GEMINI_PORT aliases", () => {
    expect(discoverLocalAntigravityEndpoint({ AGY_PORT: "50000" })).toEqual({
      port: 50000,
      csrfToken: undefined,
    });
    expect(discoverLocalAntigravityEndpoint({ GEMINI_PORT: "51000" })).toEqual({
      port: 51000,
      csrfToken: undefined,
    });
  });

  it("ignores invalid port numbers", () => {
    expect(discoverLocalAntigravityEndpoint({ ANTIGRAVITY_PORT: "0" })).toBeUndefined();
    expect(discoverLocalAntigravityEndpoint({ ANTIGRAVITY_PORT: "70000" })).toBeUndefined();
    expect(discoverLocalAntigravityEndpoint({ ANTIGRAVITY_PORT: "not-a-port" })).toBeUndefined();
  });
});
