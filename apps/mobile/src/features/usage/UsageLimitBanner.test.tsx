import { describe, expect, it } from "vite-plus/test";
import type { NavigationState } from "@react-navigation/native";

import { usageBannerCellWidth, usageBannerHeight } from "./usage-banner-layout";
import { createUsageBannerExpansionStore } from "./usage-banner-expansion";

const routeState = (name: string, key = name): NavigationState =>
  ({
    key: "root",
    type: "stack",
    stale: false as const,
    index: 0,
    routeNames: [name],
    routes: [{ key, name }],
  }) as NavigationState;

describe("workspace quota banner expansion lifecycle", () => {
  it("keeps AGY expanded while the active workspace route changes", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["codex", "agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    store.syncNavigation(routeState("Home"));
    store.syncAccounts(["codex", "agy-1", "agy-2", "agy-3"], ["agy-1", "agy-2", "agy-3"]);
    store.syncNavigation(routeState("Thread", "thread-1"));
    expect(store.getSnapshot()).toBe(true);
  });

  it("collapses only on Settings, background, or account scope loss", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["agy-1", "agy-2"], ["agy-1", "agy-2"]);
    store.setExpanded(true);
    store.syncNavigation(routeState("ThreadSettingsSheet"));
    expect(store.getSnapshot()).toBe(false);

    store.setExpanded(true);
    store.setForeground(false);
    expect(store.getSnapshot()).toBe(false);

    store.setExpanded(true);
    store.syncAccounts(["agy-1"], ["agy-1"]);
    expect(store.getSnapshot()).toBe(false);
  });

  it("clears expansion when the last AGY account disappears", () => {
    const store = createUsageBannerExpansionStore();
    store.syncAccounts(["codex-1", "agy-1"], ["agy-1"]);
    store.setExpanded(true);
    store.syncAccounts(["codex-1"], []);
    expect(store.getSnapshot()).toBe(false);
  });
});

describe("mobile usage banner layout", () => {
  it.each([320, 360, 390, 430])("keeps five collapsed cells within %i dp", (width) => {
    const cellWidth = usageBannerCellWidth(width, 5);
    expect(cellWidth * 5 + 8 + 2 * 4).toBeLessThanOrEqual(width);
    expect(cellWidth).toBeGreaterThanOrEqual(48);
  });

  it.each([
    [1, 48],
    [1.15, Math.ceil(72 * 1.15 + 8)],
    [1.3, Math.ceil(72 * 1.3 + 8)],
    [1.8, Math.ceil(72 * 1.8 + 8)],
    [2, Math.ceil(72 * 2 + 8)],
  ])("uses the accessible strip height at font scale %s", (scale, expected) => {
    expect(usageBannerHeight(scale)).toBe(expected);
  });
});
