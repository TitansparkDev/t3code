import {
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
  type ServerProviderUsageLimits,
  type ServerProviderUsageWindow,
  type UsageLimitSourceSnapshot,
  UsageLimitSourceId,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  type UsageBannerAccountCell,
  type UsageBannerEntry,
  type UsageBannerModel,
  type UsageBannerPresentations,
  type UsageBannerSummaryCell,
  buildUsageBannerModel,
  formatCountdown,
  reuseUsageBannerModel,
  spokenDuration,
} from "./usage-banner-model.ts";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const now = Date.parse("2026-10-22T12:00:00.000Z");
const at = (ms: number) => new Date(ms).toISOString();
const fresh = at(now - 2 * MINUTE);

const codex = ProviderDriverKind.make("codex");
const claude = ProviderDriverKind.make("claudeAgent");
const antigravity = ProviderDriverKind.make("antigravity");

function window(overrides: Partial<ServerProviderUsageWindow>): ServerProviderUsageWindow {
  return {
    id: "primary",
    kind: "session",
    label: "Session",
    usedPercent: 20,
    windowDurationMins: 300,
    resetsAt: at(now + 265 * MINUTE),
    ...overrides,
  };
}

function limits(
  windows: readonly ServerProviderUsageWindow[],
  overrides: Partial<ServerProviderUsageLimits> = {},
): ServerProviderUsageLimits {
  return { checkedAt: fresh, windows, ...overrides };
}

function provider(overrides: Partial<ServerProvider>): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("codex"),
    driver: codex,
    enabled: true,
    installed: true,
    version: null,
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: fresh,
    models: [],
    slashCommands: [],
    skills: [],
    ...overrides,
  };
}

const source = {
  id: UsageLimitSourceId.make("hub"),
  kind: "cliproxy" as const,
  label: "hub",
  checkedAt: fresh,
};

function environment(
  id: string,
  label: string,
  input: {
    readonly providers?: readonly ServerProvider[];
    readonly sources?: readonly UsageLimitSourceSnapshot[];
    readonly phase?: string;
  } = {},
): [EnvironmentId, UsageBannerEntry] {
  return [
    EnvironmentId.make(id),
    {
      entry: { target: { label } },
      connection: { phase: input.phase ?? "connected" },
      serverConfig: {
        providers: input.providers ?? [],
        usageLimitSources: input.sources ?? [],
      },
    },
  ];
}

function model(...environments: [EnvironmentId, UsageBannerEntry][]): UsageBannerModel {
  return buildUsageBannerModel(new Map(environments), now);
}

function accounts(result: UsageBannerModel): UsageBannerAccountCell[] {
  return result.cells.filter((cell): cell is UsageBannerAccountCell => cell.kind === "account");
}

function summary(result: UsageBannerModel): UsageBannerSummaryCell {
  const cell = result.cells.find(
    (item): item is UsageBannerSummaryCell => item.kind === "antigravity",
  );
  if (cell === undefined) throw new Error("expected an Antigravity summary");
  return cell;
}

function codexWith(
  email: string,
  windows: readonly ServerProviderUsageWindow[],
  overrides: Partial<ServerProvider> = {},
): ServerProvider {
  return provider({
    auth: { status: "authenticated", email },
    usageLimits: limits(windows),
    ...overrides,
  });
}

function sourceAccount(
  id: string,
  driverKind: typeof codex,
  usageLimits: ServerProviderUsageLimits,
  extra: { email?: string; workspaceId?: string } = {},
) {
  return { id, driver: driverKind, usageLimits, ...extra };
}

describe("account rows", () => {
  it("shows 80% left for 20% used and pairs each row with its own reset", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("alice@example.com", [
              window({ id: "primary", kind: "session", usedPercent: 20 }),
              window({
                id: "secondary",
                kind: "weekly",
                label: "Weekly",
                usedPercent: 0,
                resetsAt: at(now + 6 * DAY),
              }),
            ]),
          ],
        }),
      ),
    );
    expect(cell?.rows[0]).toMatchObject({ percent: 80, reset: { countdown: "4:25" } });
    expect(cell?.rows[1]).toMatchObject({ percent: 100, reset: { countdown: "6d" } });
    expect(cell?.accessibleLabel).toBe(
      "Codex, 80 percent of short limit left, resets in 4 hours 25 minutes; 100 percent of weekly limit left, resets in 6 days; checked 2 minutes ago. Open account limits.",
    );
  });

  it("names the account by its display name and never by email", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("alice@example.com", [window({})], { displayName: "Personal" })],
        }),
      ),
    );
    expect(cell?.name).toBe("Personal");
    expect(cell?.accessibleLabel).toContain("Codex, Personal, ");
    expect(cell?.accessibleLabel).not.toContain("alice@example.com");
  });

  it("keeps fractional and boundary percentages exact: 0, 100 and rounding of 33.3 used", () => {
    const percentOf = (usedPercent: number) =>
      accounts(
        model(
          environment("env-a", "Laptop", {
            providers: [codexWith("a@example.com", [window({ usedPercent })])],
          }),
        ),
      )[0]?.rows[0].percent;
    expect(percentOf(0)).toBe(100);
    expect(percentOf(100)).toBe(0);
    expect(percentOf(33.3)).toBe(67);
  });

  it("uses the lowest remaining window per slot, breaking ties by stable window id", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            provider({
              driver: claude,
              instanceId: ProviderInstanceId.make("claude"),
              auth: { status: "authenticated", email: "c@example.com" },
              usageLimits: limits([
                window({ id: "zeta", kind: "session", usedPercent: 40 }),
                window({ id: "alpha", kind: "session", usedPercent: 40 }),
              ]),
            }),
          ],
        }),
      ),
    );
    expect(cell?.rows[0]).toMatchObject({ percent: 60 });
    expect(cell?.navigation.window).toEqual({ id: "alpha", kind: "session" });
  });

  it("fills the short row from an other quota only when no session window exists, naming its family", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [
              window({
                id: "credits",
                kind: "other",
                label: "Flow credits",
                usedPercent: 25,
                resetsAt: undefined,
              }),
            ]),
          ],
        }),
      ),
    );
    expect(cell?.rows[0]).toMatchObject({ percent: 75, family: "Flow credits" });
    expect(cell?.rows[0].label).toBe("Flow credits quota");
    expect(cell?.rows[0].reset.countdown).toBe("—");
    expect(cell?.rows[0].reset.speech).toBe("reset time unknown");
  });

  it("leaves a missing weekly slot unknown while the short row still reads", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", { providers: [codexWith("a@example.com", [window({})])] }),
      ),
    );
    expect(cell?.rows[1]).toMatchObject({ percent: null, reset: { countdown: "—" } });
    expect(cell?.rows[0].percent).toBe(80);
  });

  it("ignores windows of other kinds such as monthly", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [window({ id: "month", kind: "monthly", usedPercent: 99 })]),
          ],
        }),
      ),
    );
    expect(cell?.rows).toMatchObject([{ percent: null }, { percent: null }]);
  });

  it("does not change a row when only the window duration is reported differently", () => {
    const withDuration = (windowDurationMins: number) =>
      accounts(
        model(
          environment("env-a", "Laptop", {
            providers: [codexWith("a@example.com", [window({ windowDurationMins })])],
          }),
        ),
      )[0]?.rows;
    expect(withDuration(60)).toEqual(withDuration(300));
  });
});

describe("countdowns", () => {
  it("rounds up across the minute, hour, day boundaries", () => {
    expect(formatCountdown(59 * MINUTE)).toBe("59min");
    expect(formatCountdown(59 * MINUTE + 1)).toBe("1:00");
    expect(formatCountdown(60 * MINUTE)).toBe("1:00");
    expect(formatCountdown(1439 * MINUTE)).toBe("23:59");
    expect(formatCountdown(1440 * MINUTE)).toBe("24h");
    expect(formatCountdown(2879 * MINUTE)).toBe("48h");
    expect(formatCountdown(2880 * MINUTE)).toBe("2d");
    expect(formatCountdown(99 * DAY)).toBe("99d");
    expect(formatCountdown(100 * DAY)).toBe(">99d");
  });

  it("shows a sub-minute reset as one minute and speaks the same rounding", () => {
    expect(formatCountdown(30_000)).toBe("1min");
    expect(spokenDuration(30_000)).toBe("1 minute");
    expect(spokenDuration(4 * HOUR + 25 * MINUTE)).toBe("4 hours 25 minutes");
    expect(spokenDuration(2 * DAY)).toBe("2 days");
  });

  it("follows the window's own reset rather than a duration label", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("a@example.com", [window({ resetsAt: at(now + 59 * MINUTE) })])],
        }),
      ),
    );
    expect(cell?.rows[0].reset).toMatchObject({ countdown: "59min", at: now + 59 * MINUTE });
  });

  it("shows missing and invalid resets as unknown while keeping the percentage", () => {
    const [missing, invalid] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [window({ resetsAt: undefined })]),
            codexWith("b@example.com", [window({ resetsAt: "not-a-date" as never })]),
          ],
        }),
      ),
    );
    expect(missing?.rows[0]).toMatchObject({ percent: 80, reset: { at: null, countdown: "—" } });
    expect(invalid?.rows[0]).toMatchObject({ percent: 80, reset: { at: null, countdown: "—" } });
  });

  it("shows now and a stale reason once a reset has passed, never 100%", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("a@example.com", [window({ resetsAt: at(now - MINUTE) })])],
        }),
      ),
    );
    expect(cell?.rows[0]).toMatchObject({
      percent: 80,
      reset: { countdown: "now" },
      staleReasons: ["reset"],
    });
    expect(cell?.staleReasons).toEqual(["reset"]);
  });

  it("handles a very distant reset without an unbounded number", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("a@example.com", [window({ resetsAt: at(now + 400 * DAY) })])],
        }),
      ),
    );
    expect(cell?.rows[0].reset.countdown).toBe(">99d");
  });

  it("recomputes from the current time on a later foreground resume, with no stored countdown", () => {
    const presentations: UsageBannerPresentations = new Map([
      environment("env-a", "Laptop", {
        providers: [codexWith("a@example.com", [window({ resetsAt: at(now + 265 * MINUTE) })])],
      }),
    ]);
    expect(accounts(buildUsageBannerModel(presentations, now))[0]?.rows[0].reset.countdown).toBe(
      "4:25",
    );
    expect(
      accounts(buildUsageBannerModel(presentations, now + 2 * HOUR))[0]?.rows[0].reset,
    ).toMatchObject({ countdown: "2:25" });
    expect(
      accounts(buildUsageBannerModel(presentations, now + 6 * HOUR))[0]?.rows[0],
    ).toMatchObject({ reset: { countdown: "now" }, staleReasons: ["age", "reset"] });
  });
});

describe("freshness", () => {
  it("retains an old sample with a stale reason and keeps its number", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [window({})], {
              usageLimits: limits([window({})], { checkedAt: at(now - 20 * MINUTE) }),
            }),
          ],
        }),
      ),
    );
    expect(cell?.rows[0].percent).toBe(80);
    expect(cell?.staleReasons).toEqual(["age"]);
    expect(cell?.accessibleLabel).toContain("last checked more than 15 minutes ago");
  });

  it("flags a sample stamped in the future as a clock problem rather than fresh", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [window({})], {
              usageLimits: limits([window({})], { checkedAt: at(now + 5 * MINUTE) }),
            }),
          ],
        }),
      ),
    );
    expect(cell?.staleReasons).toEqual(["clock"]);
  });

  it("treats a sample from a disconnected environment as stale, not removed", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          phase: "reconnecting",
          providers: [codexWith("a@example.com", [window({})])],
        }),
      ),
    );
    expect(cell?.rows[0].percent).toBe(80);
    expect(cell?.staleReasons).toEqual(["disconnected"]);
  });

  it("marks a clock jump forward as a stale sample instead of a fresh 100%", () => {
    const presentations: UsageBannerPresentations = new Map([
      environment("env-a", "Laptop", {
        providers: [codexWith("a@example.com", [window({ resetsAt: at(now + HOUR) })])],
      }),
    ]);
    const later = accounts(buildUsageBannerModel(presentations, now + 3 * HOUR))[0];
    expect(later?.rows[0]).toMatchObject({
      percent: 80,
      reset: { countdown: "now" },
      staleReasons: ["age", "reset"],
    });
  });
});

describe("configured accounts", () => {
  it("shows an unauthenticated native instance as a placeholder with a reason", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [provider({ auth: { status: "unauthenticated" } })],
        }),
      ),
    );
    expect(cell?.placeholder).toBe("Sign in to read limits");
    expect(cell?.rows.map((row) => row.percent)).toEqual([null, null]);
  });

  it("shows an unsupported account as unknown, not as zero", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [], {
              usageLimits: limits([], { unavailable: { reason: "unsupported" } }),
            }),
          ],
        }),
      ),
    );
    expect(cell?.placeholder).toBe("No subscription limits");
    expect(cell?.rows[0]).toMatchObject({ percent: null, reset: { countdown: "—" } });
  });

  it("hides retained quota windows when the account reports unsupported limits", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [], {
              usageLimits: limits([window({ usedPercent: 45 })], {
                unavailable: { reason: "unsupported" },
              }),
            }),
          ],
        }),
      ),
    );
    expect(cell?.placeholder).toBe("No subscription limits");
    expect(cell?.rows.map((row) => row.percent)).toEqual([null, null]);
    expect(cell?.rows.map((row) => row.reset.countdown)).toEqual(["—", "—"]);
  });

  it("keeps a configured account with a failed probe in place as a placeholder", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [
          codexWith("a@example.com", [], {
            usageLimits: limits([], { unavailable: { reason: "probeFailed" } }),
          }),
        ],
      }),
    );
    expect(accounts(result)).toHaveLength(1);
    expect(accounts(result)[0]?.placeholder).toBe("Last reading failed");
  });

  it("keeps the last numbers stale when a failed probe still reports windows", () => {
    const [cell] = accounts(
      model(
        environment("env-a", "Laptop", {
          providers: [
            codexWith("a@example.com", [], {
              usageLimits: limits([window({})], { unavailable: { reason: "probeFailed" } }),
            }),
          ],
        }),
      ),
    );
    expect(cell?.placeholder).toBeNull();
    expect(cell?.rows[0].percent).toBe(80);
    expect(cell?.staleReasons).toEqual(["probeFailed"]);
  });

  it("hides a provider that is not installed and so is not configured", () => {
    expect(
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("a@example.com", [window({})], { installed: false })],
        }),
      ).cells,
    ).toEqual([]);
  });

  it("shows no strip when no account is configured anywhere", () => {
    expect(model().cells).toEqual([]);
    expect(model(environment("env-a", "Laptop", { providers: [] })).cells).toEqual([]);
  });

  it("removes an environment's accounts immediately when it is no longer presented", () => {
    const before = model(
      environment("env-a", "Laptop", { providers: [codexWith("a@example.com", [window({})])] }),
    );
    expect(accounts(before)).toHaveLength(1);
    expect(model().cells).toEqual([]);
  });
});

describe("identity", () => {
  it("merges a native instance and its proxy duplicate into one cell", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [codexWith("same@example.com", [window({ usedPercent: 20 })])],
        sources: [
          {
            ...source,
            accounts: [
              sourceAccount("codex-same", codex, limits([window({ usedPercent: 50 })]), {
                email: "same@example.com",
              }),
            ],
          },
        ],
      }),
    );
    expect(accounts(result)).toHaveLength(1);
    expect(accounts(result)[0]?.badge).toBeNull();
  });

  it("keeps the same account on two environments as one cell listing both", () => {
    const result = model(
      environment("env-a", "Laptop", { providers: [codexWith("same@example.com", [window({})])] }),
      environment("env-b", "Desktop", { providers: [codexWith("same@example.com", [window({})])] }),
    );
    const [cell] = accounts(result);
    expect(accounts(result)).toHaveLength(1);
    expect(cell?.navigation.environmentIds).toEqual(["env-a", "env-b"]);
  });

  it("keeps distinct workspaces under one email as separate cells", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [
          codexWith("same@example.com", [window({})], {
            auth: { status: "authenticated", email: "same@example.com", workspaceId: "team-1" },
          }),
          codexWith("same@example.com", [window({ usedPercent: 60 })], {
            instanceId: ProviderInstanceId.make("codex-2"),
            auth: { status: "authenticated", email: "same@example.com", workspaceId: "team-2" },
          }),
        ],
      }),
    );
    expect(accounts(result)).toHaveLength(2);
    expect(accounts(result).map((cell) => cell.rows[0].percent)).toEqual([80, 40]);
  });

  it("does not merge accounts that have no fingerprint or email, one per environment", () => {
    const bare = provider({
      auth: { status: "authenticated" },
      usageLimits: limits([window({})]),
    });
    const result = model(
      environment("env-a", "Laptop", { providers: [bare] }),
      environment("env-b", "Desktop", { providers: [bare] }),
    );
    expect(accounts(result)).toHaveLength(2);
  });

  it("never lets a placeholder duplicate a known account that shares its fingerprint", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [
          provider({
            auth: { status: "authenticated" },
            usageLimits: limits([], {
              credentialFingerprint: "fp-1",
              unavailable: { reason: "probeFailed" },
            }),
          }),
        ],
        sources: [
          {
            ...source,
            accounts: [
              sourceAccount(
                "hub-codex",
                codex,
                limits([window({})], { credentialFingerprint: "fp-1" }),
              ),
            ],
          },
        ],
      }),
    );
    expect(accounts(result)).toHaveLength(1);
    expect(accounts(result)[0]?.placeholder).toBeNull();
    expect(accounts(result)[0]?.rows[0].percent).toBe(80);
  });
});

describe("provider grouping", () => {
  const codexAccount = (email: string, usedPercent: number, index: number) =>
    codexWith(email, [window({ usedPercent })], {
      instanceId: ProviderInstanceId.make(`codex-${index}`),
    });
  const claudeAccount = (email: string, usedPercent: number, index: number) =>
    provider({
      driver: claude,
      instanceId: ProviderInstanceId.make(`claude-${index}`),
      auth: { status: "authenticated", email },
      usageLimits: limits([window({ id: "five_hour", usedPercent })]),
    });

  it.each([
    ["1 Codex + 1 Claude", ["a@example.com"], ["c@example.com"], [null], [null]],
    ["2 Codex + 1 Claude", ["a@example.com", "b@example.com"], ["c@example.com"], [1, 2], [null]],
    ["1 Codex + 2 Claude", ["a@example.com"], ["c@example.com", "d@example.com"], [null], [1, 2]],
    [
      "2 Codex + 2 Claude",
      ["a@example.com", "b@example.com"],
      ["c@example.com", "d@example.com"],
      [1, 2],
      [1, 2],
    ],
  ])(
    "shows %s as one cell per account with account badges",
    (_name, codexEmails, claudeEmails, codexBadges, claudeBadges) => {
      const result = model(
        environment("env-a", "Laptop", {
          providers: [
            ...codexEmails.map((email, index) => codexAccount(email, 20, index)),
            ...claudeEmails.map((email, index) => claudeAccount(email, 20, index)),
          ],
        }),
      );
      const cells = accounts(result);
      expect(cells.filter((cell) => cell.provider === "codex").map((cell) => cell.badge)).toEqual(
        codexBadges,
      );
      expect(
        cells.filter((cell) => cell.provider === "claudeAgent").map((cell) => cell.badge),
      ).toEqual(claudeBadges);
    },
  );

  it("orders Codex accounts, then Claude, then one Antigravity cell", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [claudeAccount("c@example.com", 10, 0), codexAccount("a@example.com", 10, 0)],
        sources: [
          {
            ...source,
            accounts: [
              sourceAccount(
                "agy",
                antigravity,
                limits([window({ id: "gemini-5h", usedPercent: 10 })]),
                {
                  email: "agy@example.com",
                },
              ),
            ],
          },
        ],
      }),
    );
    expect(
      result.cells.map((cell) => (cell.kind === "account" ? cell.provider : cell.kind)),
    ).toEqual(["codex", "claudeAgent", "antigravity"]);
  });

  it("orders accounts by stable identity, never by percentage", () => {
    const result = model(
      environment("env-a", "Laptop", {
        providers: [codexAccount("b@example.com", 10, 0), codexAccount("a@example.com", 90, 1)],
      }),
    );
    expect(accounts(result).map((cell) => cell.id)).toEqual([
      "codex:a@example.com",
      "codex:b@example.com",
    ]);
  });
});

describe("Antigravity summary", () => {
  const agy = (
    id: string,
    email: string,
    windows: readonly ServerProviderUsageWindow[],
    extra: Partial<ServerProviderUsageLimits> = {},
  ) => sourceAccount(id, antigravity, limits(windows, extra), { email });

  it("uses the lowest matching family pool and the countdown of its next capacity-restoring reset", () => {
    const pool = (usedPercent: number, minutes: number) =>
      window({ id: "gemini-5h", usedPercent, resetsAt: at(now + minutes * MINUTE) });
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [pool(0, 30)]),
              agy("b", "b@example.com", [pool(50, 120)]),
              agy("c", "c@example.com", [pool(20, 60)]),
            ],
          },
        ],
      }),
    );
    const cell = summary(result);
    expect(cell.rows[0]).toMatchObject({
      percent: 77,
      reset: { countdown: "1:00" },
      coverage: { reporting: 3, accounts: 3, timed: 3 },
    });
    expect(cell.accountCount).toBe(3);
    expect(cell.accessibleLabel).toContain("next refill in 1 hour");
    expect(cell.accessibleLabel).toContain("refill time known for 3");
  });

  it("pairs the chosen family's percentage with that family's reset, never another family's", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [
                window({
                  id: "gemini-5h",
                  label: "Gemini",
                  usedPercent: 10,
                  resetsAt: at(now + 3 * HOUR),
                }),
                window({
                  id: "claude-5h",
                  label: "Claude",
                  usedPercent: 90,
                  resetsAt: at(now + 30 * MINUTE),
                }),
              ]),
            ],
          },
        ],
      }),
    );
    expect(summary(result).rows[0]).toMatchObject({ percent: 10, reset: { countdown: "30min" } });
  });

  it("shows a fallback other quota in the top row with its real family", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [
                window({ id: "credits", kind: "other", label: "Flow credits", usedPercent: 40 }),
              ]),
            ],
          },
        ],
      }),
    );
    expect(summary(result).rows[0]).toMatchObject({ percent: 60, family: "Flow credits" });
    expect(summary(result).rows[0].label).toBe("lowest Flow credits quota pool");
    expect(summary(result).rows[1].percent).toBeNull();
  });

  it("counts a failed account as a placeholder and reports partial coverage", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [window({ id: "gemini-5h", usedPercent: 10 })]),
              agy("b", "b@example.com", [], { unavailable: { reason: "probeFailed" } }),
            ],
          },
        ],
      }),
    );
    const cell = summary(result);
    expect(cell.accountCount).toBe(2);
    expect(cell.rows[0]).toMatchObject({ percent: 90, coverage: { reporting: 1, accounts: 2 } });
    expect(cell.accessibleLabel).toContain("1 of 2 accounts reporting");
    expect(cell.accounts[1]?.placeholder).toBe("Last reading failed");
  });

  it("ignores zero-restoration members when choosing the refill countdown", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [
                window({ id: "gemini-5h", usedPercent: 100, resetsAt: at(now + 2 * HOUR) }),
              ]),
              agy("b", "b@example.com", [
                window({ id: "gemini-5h", usedPercent: 0, resetsAt: at(now + 10 * MINUTE) }),
              ]),
            ],
          },
        ],
      }),
    );
    expect(summary(result).rows[0]).toMatchObject({ percent: 50, reset: { countdown: "2:00" } });
  });

  it("shows a dash when a full pool has no capacity-restoring reset", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [agy("a", "a@example.com", [window({ id: "gemini-5h", usedPercent: 0 })])],
          },
        ],
      }),
    );
    expect(summary(result).rows[0]).toMatchObject({ percent: 100, reset: { countdown: "—" } });
  });

  it("never averages different families into one quota", () => {
    const result = model(
      environment("env-a", "Laptop", {
        sources: [
          {
            ...source,
            accounts: [
              agy("a", "a@example.com", [
                window({ id: "gemini-5h", label: "Gemini", usedPercent: 10 }),
                window({ id: "claude-5h", label: "Claude", usedPercent: 90 }),
              ]),
            ],
          },
        ],
      }),
    );
    expect(summary(result).rows[0].percent).toBe(10);
    expect(summary(result).families).toEqual([
      {
        kind: "session",
        label: "Gemini",
        percent: 90,
        coverage: { reporting: 1, accounts: 1, timed: 1 },
      },
      {
        kind: "session",
        label: "Claude",
        percent: 10,
        coverage: { reporting: 1, accounts: 1, timed: 1 },
      },
    ]);
  });
});

describe("stable model", () => {
  it("returns the previous object when unrelated provider fields change", () => {
    const build = (version: string) =>
      model(
        environment("env-a", "Laptop", {
          providers: [codexWith("a@example.com", [window({})], { version })],
        }),
      );
    const first = build("1.0.0");
    const second = build("1.0.1");
    expect(second).toEqual(first);
    expect(reuseUsageBannerModel(first, second)).toBe(first);
  });

  it("returns the new object once a shown percentage changes", () => {
    const first = model(
      environment("env-a", "Laptop", {
        providers: [codexWith("a@example.com", [window({ usedPercent: 20 })])],
      }),
    );
    const second = model(
      environment("env-a", "Laptop", {
        providers: [codexWith("a@example.com", [window({ usedPercent: 30 })])],
      }),
    );
    expect(reuseUsageBannerModel(first, second)).toBe(second);
  });
});
