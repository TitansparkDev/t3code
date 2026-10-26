import { describe, expect, it } from "vite-plus/test";
import type { NavigationState, PartialState } from "@react-navigation/native";

import { isWorkspaceSettingsRoute, shouldShowWorkspaceUsageBanner } from "./usage-banner-routes";

describe("shouldShowWorkspaceUsageBanner", () => {
  const state = (name: string, nested?: NavigationState): NavigationState =>
    ({
      key: "root",
      type: "stack",
      stale: false as const,
      index: 0,
      routeNames: [name],
      routes: [{ key: name, name, ...(nested ? { state: nested } : {}) }],
    }) as NavigationState;

  it("hides the underlying workspace when a settings sheet or nested settings route is active", () => {
    expect(
      shouldShowWorkspaceUsageBanner(
        state("SettingsSheet", state("SettingsContent", state("SettingsUsage"))),
      ),
    ).toBe(false);
  });

  it.each(["Home", "Thread", "NewTaskProject", "Goals"])("shows on %s", (name) => {
    expect(shouldShowWorkspaceUsageBanner(state(name))).toBe(true);
  });

  it("hides the strip for a blurred route beneath a translucent sheet", () => {
    expect(shouldShowWorkspaceUsageBanner(state("Home"), false)).toBe(false);
  });

  it("hides the banner in immersive media", () => {
    expect(shouldShowWorkspaceUsageBanner(state("McpAppFullscreen"))).toBe(false);
  });

  it("uses the last route while a nested state is partially hydrated", () => {
    const partialState: PartialState<NavigationState> = {
      routes: [
        { name: "Home" },
        { name: "SettingsSheet", state: { routes: [{ name: "SettingsUsage" }] } },
      ],
    };

    expect(shouldShowWorkspaceUsageBanner(partialState)).toBe(false);
    expect(isWorkspaceSettingsRoute(partialState)).toBe(true);
  });
});
