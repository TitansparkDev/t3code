import type { NavigationState } from "@react-navigation/native";
import { useSyncExternalStore } from "react";

import { isWorkspaceSettingsRoute } from "../../lib/adaptive-navigation";

export function createUsageBannerExpansionStore() {
  let expanded = false;
  let accountIds: Set<string> | null = null;
  let antigravityIds = new Set<string>();
  const listeners = new Set<() => void>();

  const publish = (next: boolean) => {
    if (expanded === next) return;
    expanded = next;
    for (const listener of listeners) listener();
  };

  return {
    getSnapshot: () => expanded,
    subscribe(listener: () => void) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    setExpanded: publish,
    syncNavigation(state: NavigationState) {
      if (isWorkspaceSettingsRoute(state)) publish(false);
    },
    setForeground(foreground: boolean) {
      if (!foreground) publish(false);
    },
    syncAccounts(nextAccountIds: readonly string[], nextAntigravityIds: readonly string[]) {
      const next = new Set(nextAccountIds);
      const removed = accountIds !== null && [...accountIds].some((id) => !next.has(id));
      const lostAntigravity = antigravityIds.size > 0 && nextAntigravityIds.length === 0;
      if (removed || lostAntigravity) publish(false);
      accountIds = next;
      antigravityIds = new Set(nextAntigravityIds);
    },
  };
}

export const usageBannerExpansionStore = createUsageBannerExpansionStore();

export function useUsageBannerExpanded(): readonly [boolean, (expanded: boolean) => void] {
  const expanded = useSyncExternalStore(
    usageBannerExpansionStore.subscribe,
    usageBannerExpansionStore.getSnapshot,
    usageBannerExpansionStore.getSnapshot,
  );
  return [expanded, usageBannerExpansionStore.setExpanded];
}
