import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import type { AccountQuotaSnapshot } from "@t3tools/contracts/quota";
import {
  collectLimitAccounts,
  collectLimitPools,
  withNativeQuotaSnapshots,
} from "@t3tools/shared/usageLimits";
import { describe, expect, it } from "vite-plus/test";

const env1 = EnvironmentId.make("env-1");
const agyInstanceId = ProviderInstanceId.make("agy-inst-1");

function makeAntigravityProvider(overrides: Partial<ServerProvider> = {}): ServerProvider {
  return {
    instanceId: agyInstanceId,
    driver: ProviderDriverKind.make("antigravity"),
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: "2026-09-20T00:00:00Z",
    models: [],
    slashCommands: [],
    skills: [],
    usageLimits: {
      checkedAt: "2026-09-20T00:00:00Z",
      windows: [
        {
          id: "gemini:short:300",
          kind: "session",
          label: "Gemini Models",
          usedPercent: 50,
          windowDurationMins: 300,
        },
      ],
    },
    ...overrides,
  };
}

describe("mobile usage limits live quota overlay", () => {
  it("overlays live native quota snapshots onto mobile provider presentation", () => {
    const provider = makeAntigravityProvider();
    const liveSnapshot: AccountQuotaSnapshot = {
      source: "antigravity-quota-summary",
      providerInstanceId: agyInstanceId,
      observedAt: "2026-09-21T12:00:00Z",
      groups: [
        {
          key: "gemini",
          displayName: "Gemini Models",
          windows: [
            {
              kind: "short",
              label: "Gemini Models",
              usedPercent: 25,
              windowDurationMins: 300,
              resetsAt: "2026-09-21T17:00:00Z",
            },
            {
              kind: "long",
              label: "Gemini Models",
              usedPercent: 10,
              windowDurationMins: 10080,
              resetsAt: "2026-09-28T00:00:00Z",
            },
          ],
        },
        {
          key: "claude-gpt",
          displayName: "Claude & GPT models",
          windows: [
            {
              kind: "short",
              label: "Claude & GPT models",
              usedPercent: 60,
              windowDurationMins: 300,
              resetsAt: "2026-09-21T16:00:00Z",
            },
            {
              kind: "long",
              label: "Claude & GPT models",
              usedPercent: 40,
              windowDurationMins: 10080,
              resetsAt: "2026-09-28T00:00:00Z",
            },
          ],
        },
      ],
    };

    const updatedProviders = withNativeQuotaSnapshots([provider], [liveSnapshot]);
    expect(updatedProviders[0]!.usageLimits?.checkedAt).toBe("2026-09-21T12:00:00Z");

    const presentationMap = new Map([
      [
        env1,
        {
          entry: { target: { label: "Local Machine" } },
          serverConfig: {
            providers: updatedProviders,
          },
        },
      ],
    ]);

    const accounts = collectLimitAccounts(presentationMap);
    expect(accounts).toHaveLength(1);
    expect(accounts[0]!.driver).toBe("antigravity");

    const now = Date.parse("2026-09-21T13:00:00Z");
    const pools = collectLimitPools(accounts, now);
    expect(pools).toHaveLength(1);
    expect(pools[0]!.driver).toBe("antigravity");

    // Both Gemini and Claude-GPT windows are represented
    const labels = pools[0]!.windows.map((w) => w.label);
    expect(labels).toContain("Gemini Models");
    expect(labels).toContain("Claude & GPT models");

    const geminiShort = pools[0]!.windows.find(
      (w) => w.label === "Gemini Models" && w.kind === "session",
    );
    expect(geminiShort).toBeDefined();
    expect(geminiShort?.usedPercent).toBe(25);
    expect(geminiShort?.remainingPercent).toBe(75);

    const claudeShort = pools[0]!.windows.find(
      (w) => w.label === "Claude & GPT models" && w.kind === "session",
    );
    expect(claudeShort).toBeDefined();
    expect(claudeShort?.usedPercent).toBe(60);
    expect(claudeShort?.remainingPercent).toBe(40);
  });

  it("preserves provider usage limits when live snapshot is older than checkedAt", () => {
    const provider = makeAntigravityProvider({
      usageLimits: {
        checkedAt: "2026-09-25T00:00:00Z",
        windows: [
          {
            id: "gemini:short:300",
            kind: "session",
            label: "Gemini Models",
            usedPercent: 80,
          },
        ],
      },
    });

    const olderSnapshot: AccountQuotaSnapshot = {
      source: "antigravity-quota-summary",
      providerInstanceId: agyInstanceId,
      observedAt: "2026-09-21T00:00:00Z",
      groups: [
        {
          key: "gemini",
          displayName: "Gemini Models",
          windows: [{ kind: "short", usedPercent: 10 }],
        },
      ],
    };

    const updated = withNativeQuotaSnapshots([provider], [olderSnapshot]);
    expect(updated[0]!.usageLimits?.checkedAt).toBe("2026-09-25T00:00:00Z");
    expect(updated[0]!.usageLimits?.windows[0]?.usedPercent).toBe(80);
  });
});
