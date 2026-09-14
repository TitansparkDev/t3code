import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";
import { useCallback, useMemo, useState } from "react";
import { ActivityIndicator, Alert, Pressable } from "react-native";

import { SymbolView } from "../../components/AppSymbol";
import { AppText as Text } from "../../components/AppText";
import { cn } from "../../lib/cn";
import { createProviderRefreshRunner } from "./providerRefresh";

export {
  canRefreshProviders,
  createProviderRefreshRunner,
  providerRefreshAlert,
} from "./providerRefresh";

export function ProviderRefreshButton(props: {
  readonly onRefresh: () => Promise<AtomCommandResult<unknown, unknown>>;
  readonly compact?: boolean;
}) {
  const [isRefreshing, setIsRefreshing] = useState(false);
  const refresh = useMemo(
    () =>
      createProviderRefreshRunner(props.onRefresh, (alert) => {
        Alert.alert(alert.title, alert.message);
      }),
    [props.onRefresh],
  );

  const handlePress = useCallback(() => {
    const pending = refresh();
    if (!pending) return;
    setIsRefreshing(true);
    void pending.then(
      () => setIsRefreshing(false),
      () => setIsRefreshing(false),
    );
  }, [refresh]);

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Refresh providers"
      accessibilityState={{ busy: isRefreshing, disabled: isRefreshing }}
      disabled={isRefreshing}
      testID="refresh-providers-button"
      onPress={handlePress}
      className={cn(
        "items-center justify-center rounded-[14px] border border-input-border bg-input active:opacity-70 disabled:opacity-50",
        props.compact ? "h-[42px] w-[42px]" : "min-h-[42px] flex-row gap-1.5 px-3.5 py-2.5",
      )}
    >
      {isRefreshing ? (
        <ActivityIndicator colorClassName="accent-icon" size="small" />
      ) : (
        <SymbolView
          name="arrow.clockwise"
          size={14}
          tintColorClassName="accent-icon"
          type="monochrome"
        />
      )}
      {props.compact ? null : (
        <Text className="text-xs font-t3-bold tracking-[0.8px] uppercase text-foreground">
          Refresh providers
        </Text>
      )}
    </Pressable>
  );
}
