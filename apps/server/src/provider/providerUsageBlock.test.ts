import type { ServerProvider } from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";

import { providerBlock, providerUsageReport } from "./providerUsageBlock.ts";

const providerSnapshot = (
  instanceId: string,
  overrides: Record<string, unknown> = {},
): ServerProvider =>
  ({
    instanceId,
    driver: instanceId,
    displayName: instanceId,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-10-04T12:00:00.000Z",
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  }) as unknown as ServerProvider;

const now = Date.parse("2026-10-04T12:00:00.000Z");
const RESET = "2026-10-09T00:00:00.000Z";
const window = (
  id: string,
  label: string,
  usedPercent: number,
  resetsAt: string | undefined = RESET,
  kind: "session" | "weekly" = "weekly",
) => ({ id, kind, label, usedPercent, ...(resetsAt === undefined ? {} : { resetsAt }) });
const withWindows = (...windows: ReturnType<typeof window>[]) =>
  providerSnapshot("codex", { usageLimits: { checkedAt: "2026-10-04T12:00:00.000Z", windows } });

it("blocks a provider whose general usage window is used up until it resets", () => {
  expect(providerBlock(withWindows(window("primary", "Weekly", 100)), "gpt-6", now)).toEqual({
    until: Date.parse(RESET),
    reason: "is out of usage",
  });
  // A window that has already reset, or is not full, is ignored.
  expect(
    providerBlock(
      withWindows(window("primary", "Weekly", 100, "2026-10-01T00:00:00.000Z")),
      "gpt-6",
      now,
    ),
  ).toBeUndefined();
  expect(providerBlock(withWindows(window("primary", "Weekly", 90)), "gpt-6", now)).toBeUndefined();
});

it("blocks only the models a model-family window covers", () => {
  const opus = withWindows(window("seven_day_opus", "Opus weekly", 100));
  expect(providerBlock(opus, "sonnet", now)).toBeUndefined();
  expect(providerBlock(opus, "opus-4", now)).toBeDefined();
});

it("explains why a provider is not set up, switched off, not installed or signed out", () => {
  expect(providerBlock(undefined, "gpt-6", now)?.reason).toBe("is not set up");
  expect(providerBlock(providerSnapshot("codex", { enabled: false }), "gpt-6", now)?.reason).toBe(
    "is switched off",
  );
  expect(providerBlock(providerSnapshot("codex", { installed: false }), "gpt-6", now)?.reason).toBe(
    "is not installed",
  );
  expect(
    providerBlock(providerSnapshot("codex", { auth: { status: "unauthenticated" } }), "gpt-6", now)
      ?.reason,
  ).toBe("is signed out");
});

it("reports a provider with usage windows and no full window as available", () => {
  const report = providerUsageReport(
    withWindows(window("five_hour", "5-hour", 40, RESET, "session")),
    now,
  );
  expect(report).toEqual({
    checkedAt: "2026-10-04T12:00:00.000Z",
    windows: [{ label: "5-hour", kind: "session", usedPercent: 40, resetsAt: RESET }],
    status: "available",
  });
});

it("reports a provider with a full general window as limited until it resets", () => {
  const report = providerUsageReport(withWindows(window("primary", "Weekly", 100)), now);
  expect(report.status).toBe("limited");
  expect(report.limitedUntil).toBe(RESET);
  expect(report.reason).toBe("is out of usage");
});

it("reports unknown when the provider has no usage data or cannot report it", () => {
  expect(providerUsageReport(providerSnapshot("codex"), now)).toEqual({
    windows: [],
    status: "unknown",
    reason: "does not report usage",
  });
  expect(
    providerUsageReport(
      providerSnapshot("codex", {
        usageLimits: {
          checkedAt: "2026-10-04T12:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed", message: "probe timed out" },
        },
      }),
      now,
    ),
  ).toEqual({
    checkedAt: "2026-10-04T12:00:00.000Z",
    windows: [],
    status: "unknown",
    reason: "probe timed out",
  });
  expect(providerUsageReport(providerSnapshot("codex", { installed: false }), now).status).toBe(
    "unknown",
  );
});
