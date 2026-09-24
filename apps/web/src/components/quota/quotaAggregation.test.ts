import { ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { AccountQuotaSnapshot, QuotaGroup } from "@t3tools/contracts/quota";
import { describe, expect, it } from "vite-plus/test";

import {
  antigravityQuotaWindow,
  averageAntigravityQuotaWindow,
  averageAntigravityWindowForKind,
  accountQuotaRemainingPercent,
  groupAccountsByIdentity,
  groupQuotaPanelAccounts,
  quotaWindowForKind,
  summarizeAntigravityQuota,
  type QuotaAggregationAccount,
} from "./quotaAggregation";

const NOW = Date.parse("2026-08-27T12:00:00.000Z");

function group(key: string, usedPercent: number): QuotaGroup {
  return {
    key,
    displayName: key,
    windows: [{ kind: "unknown", usedPercent }],
  };
}

function snapshot(
  instanceId: string,
  groups: ReadonlyArray<QuotaGroup>,
  observedAt = "2026-08-27T11:00:00.000Z",
): AccountQuotaSnapshot {
  return {
    providerInstanceId: ProviderInstanceId.make(instanceId),
    groups,
    source: "provider-event",
    observedAt,
  };
}

function account(
  key: string,
  snapshotValue?: AccountQuotaSnapshot,
  displayName = key,
): QuotaAggregationAccount {
  return {
    key,
    instance: { driverKind: ProviderDriverKind.make("antigravity"), displayName },
    snapshot: snapshotValue,
  };
}

describe("quotaAggregation", () => {
  it("selects the requested 5-hour and weekly windows", () => {
    const value = snapshot("codex-1", [
      {
        key: "default",
        displayName: "Subscription",
        windows: [
          { kind: "short", usedPercent: 20 },
          { kind: "long", usedPercent: 60 },
        ],
      },
    ]);

    expect(quotaWindowForKind(value, "short", NOW)?.usedPercent).toBe(20);
    expect(quotaWindowForKind(value, "long", NOW)?.usedPercent).toBe(60);
  });

  it("averages Antigravity weekly pools independently", () => {
    const first = snapshot("agy-one", [
      { key: "gemini", displayName: "Gemini Models", windows: [{ kind: "long", usedPercent: 20 }] },
      {
        key: "claude-gpt",
        displayName: "Claude and GPT models",
        windows: [{ kind: "long", usedPercent: 60 }],
      },
    ]);
    const second = snapshot("agy-two", [
      { key: "gemini", displayName: "Gemini Models", windows: [{ kind: "long", usedPercent: 40 }] },
      {
        key: "claude-gpt",
        displayName: "Claude and GPT models",
        windows: [{ kind: "long", usedPercent: 80 }],
      },
    ]);

    expect(antigravityQuotaWindow(first, "gemini", NOW)?.usedPercent).toBe(20);
    expect(
      averageAntigravityQuotaWindow([account("one", first), account("two", second)], "gemini", NOW)
        ?.usedPercent,
    ).toBe(30);
    expect(
      averageAntigravityQuotaWindow(
        [account("one", first), account("two", second)],
        "claude-gpt",
        NOW,
      )?.usedPercent,
    ).toBe(70);
  });

  it("does not match unknown model groups to claude-gpt", () => {
    const custom = snapshot("agy-custom", [
      {
        key: "custom-models",
        displayName: "Other models",
        windows: [{ kind: "long", usedPercent: 55 }],
      },
    ]);

    expect(antigravityQuotaWindow(custom, "gemini", NOW)).toBeUndefined();
    expect(antigravityQuotaWindow(custom, "claude-gpt", NOW)).toBeUndefined();
  });

  it("shows 5-hour and weekly AGY totals using the most constrained pool per account", () => {
    const first = snapshot("agy-one", [
      {
        key: "gemini",
        displayName: "Gemini Models",
        windows: [
          { kind: "short", usedPercent: 10 },
          { kind: "long", usedPercent: 20 },
        ],
      },
      {
        key: "claude-gpt",
        displayName: "Claude and GPT models",
        windows: [
          { kind: "short", usedPercent: 100 },
          { kind: "long", usedPercent: 70 },
        ],
      },
    ]);
    const second = snapshot("agy-two", [
      {
        key: "gemini",
        displayName: "Gemini Models",
        windows: [
          { kind: "short", usedPercent: 20 },
          { kind: "long", usedPercent: 40 },
        ],
      },
    ]);

    expect(
      averageAntigravityWindowForKind([account("one", first), account("two", second)], "short", NOW)
        ?.usedPercent,
    ).toBe(60);
    expect(
      averageAntigravityWindowForKind([account("one", first), account("two", second)], "long", NOW)
        ?.usedPercent,
    ).toBe(55);
    expect(antigravityQuotaWindow(first, "gemini", NOW, "short")?.usedPercent).toBe(10);
    expect(antigravityQuotaWindow(first, "claude-gpt", NOW, "short")?.usedPercent).toBe(100);
    expect(
      averageAntigravityQuotaWindow(
        [account("one", first), account("two", second)],
        "gemini",
        NOW,
        "short",
      )?.usedPercent,
    ).toBe(15);
  });

  it("collapses the same labeled account across environments", () => {
    const rows = groupQuotaPanelAccounts([
      {
        ...account("windows:claude-1", snapshot("claude-1", [group("Subscription", 40)])),
        instance: { driverKind: ProviderDriverKind.make("claudeAgent"), displayName: "Claude-1" },
      },
      {
        ...account("windows:agy-1", undefined, "AGY-1"),
        instance: { driverKind: ProviderDriverKind.make("antigravity"), displayName: "AGY-1" },
      },
      {
        ...account(
          "ubuntu:claude-1",
          snapshot("claude-1", [group("Subscription", 20)], "2026-08-27T11:30:00.000Z"),
        ),
        instance: { driverKind: ProviderDriverKind.make("claudeAgent"), displayName: "Claude-1" },
      },
      {
        ...account("ubuntu:agy-2", undefined, "AGY-2"),
        instance: { driverKind: ProviderDriverKind.make("antigravity"), displayName: "AGY-2" },
      },
    ]);

    expect(rows).toHaveLength(3);
    expect(rows.map((row) => row.account.instance.displayName)).toEqual([
      "Claude-1",
      "AGY-1",
      "AGY-2",
    ]);
    expect(rows[0]?.account.key).toBe("claudeAgent:claude-1");
    expect(rows[0]?.account.snapshot?.groups[0]?.windows[0]?.usedPercent).toBe(20);
  });

  it("averages each Antigravity account's pools before averaging accounts", () => {
    const first = snapshot("agy-one", [group("Gemini", 20), group("Claude", 60)]);
    const second = snapshot("agy-two", [group("Gemini", 0)]);

    expect(accountQuotaRemainingPercent(first, NOW)).toBe(60);
    expect(
      summarizeAntigravityQuota([account("one", first), account("two", second)], NOW),
    ).toMatchObject({
      averageRemainingPercent: 80,
      accountsWithQuota: 2,
      accountsWithSnapshots: 2,
      accountsWithExposedWindows: 2,
    });
  });

  it("excludes stale accounts from the headline and reports missing data honestly", () => {
    const fresh = snapshot("agy-fresh", [group("Gemini", 50)]);
    const stale = snapshot("agy-stale", [group("Gemini", 0)], "2026-08-26T00:00:00.000Z");
    const empty = snapshot("agy-empty", []);

    expect(
      summarizeAntigravityQuota(
        [account("fresh", fresh), account("stale", stale), account("empty", empty)],
        NOW,
      ),
    ).toMatchObject({
      averageRemainingPercent: 50,
      accountsWithQuota: 1,
      accountsWithSnapshots: 3,
      accountsWithStaleSnapshots: 1,
      accountsWithExposedWindows: 1,
    });
    expect(accountQuotaRemainingPercent(stale, NOW)).toBeUndefined();
    expect(accountQuotaRemainingPercent(empty, NOW)).toBeUndefined();
  });

  it("preserves last-known quota numbers when includeStale is true", () => {
    const stale = snapshot(
      "agy-stale",
      [
        {
          key: "gemini",
          displayName: "Gemini Models",
          windows: [{ kind: "long", usedPercent: 35 }],
        },
      ],
      "2026-08-26T00:00:00.000Z",
    );

    expect(quotaWindowForKind(stale, "long", NOW)).toBeUndefined();
    expect(quotaWindowForKind(stale, "long", NOW, true)?.usedPercent).toBe(35);

    expect(antigravityQuotaWindow(stale, "gemini", NOW, "long")).toBeUndefined();
    expect(antigravityQuotaWindow(stale, "gemini", NOW, "long", true)?.usedPercent).toBe(35);

    // Falls back to stale when no fresh accounts exist so UI does not blank out
    expect(
      averageAntigravityQuotaWindow([account("stale", stale)], "gemini", NOW)?.usedPercent,
    ).toBe(35);
  });
});

describe("groupAccountsByIdentity", () => {
  const withAccount = (
    key: string,
    accountLabel: string | undefined,
    observedAt = "2026-08-27T11:00:00.000Z",
  ): QuotaAggregationAccount => ({
    ...account(key, {
      ...snapshot(key, [group("Gemini", 5)], observedAt),
      ...(accountLabel ? { accountLabel } : {}),
    }),
  });

  it("collapses instances that report the same account", () => {
    const groups = groupAccountsByIdentity([
      withAccount("agy-1", "one@example.com", "2026-08-27T10:00:00.000Z"),
      withAccount("agy-2", "one@example.com", "2026-08-27T11:30:00.000Z"),
      withAccount("agy-3", "two@example.com"),
    ]);

    expect(groups).toHaveLength(2);
    expect(groups[0]?.accounts.map((entry) => entry.key)).toEqual(["agy-1", "agy-2"]);
    // The newest reading represents the shared account.
    expect(groups[0]?.representative.key).toBe("agy-2");
    expect(groups[1]?.accounts).toHaveLength(1);
  });

  it("never merges accounts it cannot identify", () => {
    const groups = groupAccountsByIdentity([
      withAccount("agy-1", undefined),
      withAccount("agy-2", undefined),
    ]);
    expect(groups.map((entry) => entry.accounts.length)).toEqual([1, 1]);
    expect(groups.every((entry) => entry.accountLabel === undefined)).toBe(true);
  });
});
