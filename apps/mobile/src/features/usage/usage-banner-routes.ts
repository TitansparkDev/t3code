import type { NavigationState, PartialState } from "@react-navigation/native";

type NavigationBranchState = NavigationState | PartialState<NavigationState>;

const HIDDEN_WORKSPACE_BANNER_ROUTES = new Set([
  "SettingsSheet",
  "SettingsLegal",
  "SettingsLegalDocument",
  "ThreadSettingsSheet",
  "Onboarding",
  "ConnectOnboarding",
  "Pairing",
  "Authentication",
  "McpAppFullscreen",
  "FullscreenMedia",
]);

/** Checks the active navigation branch so a translucent settings sheet hides the workspace underneath it. */
export function shouldShowWorkspaceUsageBanner(
  state: NavigationBranchState | undefined,
  focused = true,
): boolean {
  if (!focused || state === undefined) return false;
  const route = state.routes[state.index ?? state.routes.length - 1];
  if (!route || HIDDEN_WORKSPACE_BANNER_ROUTES.has(route.name)) return false;
  if (route.name.startsWith("Settings")) return false;
  return route.state === undefined || shouldShowWorkspaceUsageBanner(route.state);
}

export function isWorkspaceSettingsRoute(state: NavigationBranchState | undefined): boolean {
  if (!state) return false;
  const route = state.routes[state.index ?? state.routes.length - 1];
  if (!route) return false;
  return (
    route.name.startsWith("Settings") ||
    route.name === "ThreadSettingsSheet" ||
    isWorkspaceSettingsRoute(route.state)
  );
}
