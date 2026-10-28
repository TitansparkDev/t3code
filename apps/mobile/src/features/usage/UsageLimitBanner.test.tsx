import type { NavigationState } from "@react-navigation/native";
import { describe, expect, it, vi } from "vite-plus/test";

import { createUsageBannerMinuteClock } from "./usage-banner-clock";
import { createUsageBannerExpansionStore } from "./usage-banner-expansion";
import {
  usageBannerCellWidth,
  usageBannerCollapsedContentWidth,
  USAGE_BANNER_COLLAPSE_CONTROL_WIDTH,
  USAGE_BANNER_CELL_GAP,
  usageBannerCollapsedNeedsScroll,
  usageBannerExpandedCellWidth,
  usageBannerHeight,
} from "./usage-banner-layout";
import type { UsageBannerAccountCell, UsageBannerRow } from "./usage-banner-model";
import {
  usageBannerAccountRouteTarget,
  usageBannerExpandedAccountLabel,
  usageBannerFocusTarget,
  usageBannerRowTone,
} from "./usage-banner-presentation";
import { isWorkspaceSettingsRoute, shouldShowWorkspaceUsageBanner } from "./usage-banner-routes";

const WIDTHS = [320, 360, 390, 430] as const;
const FONT_SCALES = [1, 1.3, 1.8, 2] as const;
const ORDINARY_ACCOUNT_COMBINATIONS = [
  [1, 1],
  [2, 1],
  [1, 2],
  [2, 2],
] as const;
const ANTIGRAVITY_ACCOUNT_COUNTS = [0, 1, 5, 20] as const;

function routeState(name: string, nested?: NavigationState): NavigationState {
  return {
    key: `state:${name}`,
    type: "stack",
    stale: false,
    index: 0,
    routeNames: [name],
    routes: [{ key: `route:${name}`, name, ...(nested ? { state: nested } : {}) }],
  };
}

function row(
  slot: UsageBannerRow["slot"],
  percent: number | null,
  countdown: string,
  options?: { readonly stale?: boolean },
): UsageBannerRow {
  return {
    slot,
    label: slot === "short" ? "five-hour limit" : "weekly limit",
    family: null,
    percent,
    reset: { at: 1_800_000, countdown, speech: `resets in ${countdown}` },
    window: { id: slot, kind: slot === "short" ? "session" : "weekly" },
    coverage: null,
    staleReasons: options?.stale ? ["age"] : [],
  };
}

function account(overrides?: Partial<UsageBannerAccountCell>): UsageBannerAccountCell {
  return {
    kind: "account",
    id: "codex:stable-account",
    provider: "codex",
    badge: null,
    name: "Personal",
    placeholder: null,
    rows: [row("short", 80, "4:25"), row("weekly", 100, "6d")],
    checkedAt: 0,
    staleReasons: [],
    navigation: {
      accountKey: "stable-account-key",
      environmentIds: ["env-a", "env-b"],
      window: { id: "short", kind: "session" },
    },
    accessibleLabel: "Codex Personal limits",
    ...overrides,
  };
}

function createClockHarness() {
  let now = 1_000;
  let nextId = 0;
  const timers = new Map<number, () => void>();
  const setInterval = vi.fn((callback: () => void) => {
    const id = ++nextId;
    timers.set(id, callback);
    return id;
  });
  const clearInterval = vi.fn((handle: unknown) => {
    timers.delete(handle as number);
  });
  const clock = createUsageBannerMinuteClock({
    now: () => now,
    setInterval,
    clearInterval,
    initiallyForeground: true,
  });
  return {
    clock,
    setInterval,
    clearInterval,
    activeTimerCount: () => timers.size,
    advance(ms: number) {
      now += ms;
      for (const callback of timers.values()) callback();
    },
    setNow(value: number) {
      now = value;
    },
  };
}

describe("mobile usage banner geometry", () => {
  it("fits every required ordinary-account combination and AGY summary at each width/font scale", () => {
    for (const width of WIDTHS) {
      for (const fontScale of FONT_SCALES) {
        for (const [codexAccounts, claudeAccounts] of ORDINARY_ACCOUNT_COMBINATIONS) {
          for (const agyAccounts of ANTIGRAVITY_ACCOUNT_COUNTS) {
            const cellCount = codexAccounts + claudeAccounts + (agyAccounts > 0 ? 1 : 0);
            expect(
              usageBannerCollapsedNeedsScroll(cellCount),
              `${width}px @ ${fontScale}x with ${codexAccounts} Codex, ${claudeAccounts} Claude, ${agyAccounts} AGY`,
            ).toBe(false);
            expect(usageBannerCollapsedContentWidth(width, cellCount)).toBeLessThanOrEqual(width);
            expect(usageBannerCellWidth(width, cellCount)).toBeGreaterThan(0);
            expect(usageBannerHeight(fontScale)).toBe(
              fontScale === 1 ? 48 : Math.ceil(72 * fontScale + 8),
            );
          }
        }
      }
    }
  });

  it("uses exactly 60.8 dp per cell for the five-cell 320 dp contract", () => {
    expect(usageBannerCellWidth(320, 5)).toBeCloseTo(60.8, 5);
    expect(usageBannerCollapsedContentWidth(320, 5)).toBeCloseTo(320, 5);
  });

  it("keeps required five cells non-scrolling and reserves overflow only beyond that contract", () => {
    expect(usageBannerCollapsedNeedsScroll(5)).toBe(false);
    expect(usageBannerCollapsedNeedsScroll(6)).toBe(true);
    expect(usageBannerCollapsedContentWidth(320, 6)).toBeGreaterThan(320);
  });

  it.each(FONT_SCALES)(
    "keeps AGY expansion at the same row height for font scale %s",
    (fontScale) => {
      const collapsedHeight = usageBannerHeight(fontScale);
      const expandedHeight = usageBannerHeight(fontScale);
      expect(expandedHeight).toBe(collapsedHeight);
    },
  );

  it.each(WIDTHS)(
    "expands five and twenty AGY accounts beyond the viewport horizontally at %i dp",
    (width) => {
      const expandedWidth = (accountCount: number) =>
        USAGE_BANNER_COLLAPSE_CONTROL_WIDTH +
        usageBannerExpandedCellWidth(width, accountCount) * accountCount +
        USAGE_BANNER_CELL_GAP * Math.max(0, accountCount - 1);
      expect(expandedWidth(5)).toBeGreaterThan(width);
      expect(expandedWidth(20)).toBeGreaterThan(width);
    },
  );

  it("keeps column geometry fixed when countdown text changes", () => {
    const widthBefore = usageBannerCellWidth(320, 5);
    const values = ["1min", "48min", "4:25", "23:59", "35h", "6d", ">99d", "now"];
    for (const _countdown of values) expect(usageBannerCellWidth(320, 5)).toBe(widthBefore);
  });
});

describe("workspace quota banner navigation and expansion lifecycle", () => {
  it("keeps AGY expanded across ordinary foreground workspace navigation", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["codex", "agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    store.syncNavigation(routeState("Home"));
    store.syncNavigation(routeState("Thread"));
    store.syncNavigation(routeState("ThreadFiles"));
    expect(store.getSnapshot()).toBe(true);
  });

  it("collapses on Settings entry, nested Settings routes and translucent Settings presentation", () => {
    const nestedSettings = routeState(
      "SettingsSheet",
      routeState("SettingsContent", routeState("SettingsUsage")),
    );
    expect(shouldShowWorkspaceUsageBanner(nestedSettings)).toBe(false);
    expect(isWorkspaceSettingsRoute(nestedSettings)).toBe(true);
    expect(shouldShowWorkspaceUsageBanner(routeState("Thread"), false)).toBe(false);

    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["agy-1"], ["agy-1"]);
    store.setExpanded(true);
    store.syncNavigation(nestedSettings);
    expect(store.getSnapshot()).toBe(false);
  });

  it.each([
    "Settings",
    "SettingsUsage",
    "SettingsUsageAccount",
    "SettingsLegal",
    "ThreadSettingsSheet",
    "ConnectOnboarding",
    "McpAppFullscreen",
  ])("does not show the banner on %s", (name) => {
    expect(shouldShowWorkspaceUsageBanner(routeState(name))).toBe(false);
  });

  it.each([
    "Home",
    "Thread",
    "NewTaskProject",
    "Archive",
    "Goals",
    "ThreadFiles",
    "ThreadReview",
    "ThreadTerminal",
    "ThreadBrowserPreview",
    "ThreadDevicePreview",
  ])("shows the banner on ordinary workspace route %s", (name) => {
    expect(shouldShowWorkspaceUsageBanner(routeState(name))).toBe(true);
  });

  it("collapses for background and starts the foreground session collapsed", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    store.setForeground(false);
    expect(store.getSnapshot()).toBe(false);
    store.setForeground(true);
    expect(store.getSnapshot()).toBe(false);
  });

  it("collapses if an expanded account scope is removed or all AGY accounts disappear", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["codex-1", "agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    store.syncAccounts(["codex-1", "agy-1"], ["agy-1"]);
    expect(store.getSnapshot()).toBe(false);

    store.setExpanded(true);
    store.syncAccounts(["codex-1"], []);
    expect(store.getSnapshot()).toBe(false);
  });

  it("close and Back collapse without changing route, feed position or composer state", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["agy-1", "agy-2"], ["agy-1", "agy-2"]);
    const route = routeState("Thread");
    const feedPosition = 734;
    const composerState = { text: "draft", keyboardOpen: true };

    store.setExpanded(true);
    store.setExpanded(false);
    expect(store.getSnapshot()).toBe(false);
    expect(route.routes[0]?.name).toBe("Thread");
    expect(feedPosition).toBe(734);
    expect(composerState).toEqual({ text: "draft", keyboardOpen: true });

    store.setExpanded(true);
    store.setExpanded(false);
    expect(store.getSnapshot()).toBe(false);
    expect(feedPosition).toBe(734);
  });

  it("preserves expansion, logical focus target and scroll offset across live quota refreshes", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["agy-1", "agy-2", "agy-3"], ["agy-1", "agy-2", "agy-3"]);
    store.setExpanded(true);
    const notify = vi.fn();
    const unsubscribe = store.subscribe(notify);
    const scrollOffset = 146;
    const focusTarget = usageBannerFocusTarget(store.getSnapshot());

    store.syncAccounts(["agy-1", "agy-2", "agy-3"], ["agy-1", "agy-2", "agy-3"]);

    expect(store.getSnapshot()).toBe(true);
    expect(notify).not.toHaveBeenCalled();
    expect(scrollOffset).toBe(146);
    expect(focusTarget).toBe("close");
    unsubscribe();
  });
});

describe("account interactions and presentation", () => {
  it("opens the existing account detail target with stable key, environment scope and window", () => {
    expect(usageBannerAccountRouteTarget(account(), 1234)).toEqual({
      name: "SettingsUsageAccount",
      params: {
        accountKey: "stable-account-key",
        windowId: "short",
        windowKind: "session",
        environmentIds: ["env-a", "env-b"],
        now: 1234,
      },
    });
  });

  it("does not retarget a removed account to a different account", () => {
    const tapped = account({
      id: "removed-account",
      navigation: {
        accountKey: "removed-stable-key",
        environmentIds: ["removed-env"],
        window: { id: "weekly", kind: "weekly" },
      },
      rows: [row("short", null, "—"), row("weekly", 25, "6d")],
    });
    expect(usageBannerAccountRouteTarget(tapped, 99).params.accountKey).toBe("removed-stable-key");
  });

  it("gives expanded AGY accounts stable compact labels", () => {
    expect(usageBannerExpandedAccountLabel(account({ badge: 1 }))).toBe("A1");
    expect(usageBannerExpandedAccountLabel(account({ badge: 20 }))).toBe("A20");
  });

  it("uses warning/destructive tones only for fresh known low capacity", () => {
    expect(usageBannerRowTone(row("short", 21, "4:25"))).toBe("neutral");
    expect(usageBannerRowTone(row("short", 20, "4:25"))).toBe("warning");
    expect(usageBannerRowTone(row("short", 0, "4:25"))).toBe("danger");
    expect(usageBannerRowTone(row("short", 0, "4:25", { stale: true }))).toBe("neutral");
    expect(usageBannerRowTone(row("short", null, "—"))).toBe("neutral");
  });
});

describe("shared foreground-only minute clock", () => {
  it("creates exactly one clock for multiple visible banner mounts", () => {
    const { clock, setInterval, clearInterval, activeTimerCount } = createClockHarness();
    clock.setVisible("workspace", true);
    clock.setVisible("detail-pane", true);
    expect(activeTimerCount()).toBe(1);
    expect(setInterval).toHaveBeenCalledTimes(1);

    clock.setVisible("workspace", false);
    expect(activeTimerCount()).toBe(1);
    clock.setVisible("detail-pane", false);
    expect(activeTimerCount()).toBe(0);
    expect(clearInterval).toHaveBeenCalledTimes(1);
  });

  it("stops while Settings hides the banner or the app is backgrounded, then recomputes on foreground", () => {
    const { clock, advance, activeTimerCount } = createClockHarness();
    clock.setVisible("workspace", true);
    const initial = clock.getSnapshot();

    clock.setVisible("workspace", false);
    advance(60_000);
    expect(clock.getSnapshot()).toBe(initial);
    expect(activeTimerCount()).toBe(0);

    clock.setVisible("workspace", true);
    expect(clock.getSnapshot()).toBe(initial + 60_000);
    clock.setForeground(false);
    advance(120_000);
    expect(clock.getSnapshot()).toBe(initial + 60_000);
    expect(activeTimerCount()).toBe(0);

    clock.setForeground(true);
    expect(clock.getSnapshot()).toBe(initial + 180_000);
    expect(activeTimerCount()).toBe(1);
  });

  it("recomputes immediately on data refresh without creating another interval", () => {
    const { clock, setInterval, setNow, activeTimerCount } = createClockHarness();
    clock.setVisible("workspace", true);
    setNow(7_000);
    clock.refresh();
    expect(clock.getSnapshot()).toBe(7_000);
    expect(activeTimerCount()).toBe(1);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });

  it("minute ticks update banner subscribers only and cannot move columns or rerender conversation state", () => {
    const { clock, advance } = createClockHarness();
    const bannerTick = vi.fn();
    let conversationRenderCount = 1;
    const width = usageBannerCellWidth(390, 5);
    const unsubscribe = clock.subscribe(bannerTick);
    clock.setVisible("workspace", true);
    bannerTick.mockClear();

    advance(60_000);

    expect(bannerTick).toHaveBeenCalledTimes(1);
    expect(usageBannerCellWidth(390, 5)).toBe(width);
    expect(conversationRenderCount).toBe(1);
    unsubscribe();
  });

  it("expand and collapse leave the local clock untouched after mount", () => {
    const { clock, setInterval, setNow } = createClockHarness();
    const store = createUsageBannerExpansionStore();

    clock.setVisible("workspace", true);
    const mountedNow = clock.getSnapshot();
    setNow(7_000);
    store.syncAccounts(["agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    expect(usageBannerFocusTarget(store.getSnapshot())).toBe("close");
    store.setExpanded(false);
    expect(usageBannerFocusTarget(store.getSnapshot())).toBe("summary");

    expect(clock.getSnapshot()).toBe(mountedNow);
    expect(setInterval).toHaveBeenCalledTimes(1);
  });
});
