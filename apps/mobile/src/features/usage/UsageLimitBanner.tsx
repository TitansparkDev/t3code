import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  AccessibilityInfo,
  AppState,
  BackHandler,
  findNodeHandle,
  I18nManager,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  useWindowDimensions,
} from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText } from "../../components/ui/AppText";
import { usageBannerPresentationsAtom } from "../../state/usage-banner";
import { usageBannerExpansionStore, useUsageBannerExpanded } from "./usage-banner-expansion";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { usageBannerCellWidth, usageBannerHeight } from "./usage-banner-layout";
import {
  buildUsageBannerModel,
  type UsageBannerCell,
  type UsageBannerRow,
} from "./usage-banner-model";

const MINUTE = 60_000;

function RowValue({
  row,
  fontScale,
  dense,
}: {
  readonly row: UsageBannerRow;
  readonly fontScale: number;
  readonly dense: boolean;
}) {
  const value = row.percent === null ? "—" : `${row.percent}%`;
  const timerBelow = fontScale >= 1.15;
  return (
    <View
      className={
        timerBelow
          ? "flex-1 items-center justify-center"
          : "flex-1 flex-row items-center justify-center gap-0.5"
      }
    >
      <AppText
        numberOfLines={1}
        adjustsFontSizeToFit={false}
        className={`${fontScale >= 1.15 || !dense ? "text-xs" : "text-[11px]"} font-t3-medium tabular-nums text-foreground`}
      >
        {value}
      </AppText>
      <AppText
        numberOfLines={1}
        className={`${fontScale >= 1.15 || !dense ? "text-[10px]" : "text-[9px]"} tabular-nums text-foreground-muted`}
      >
        {row.reset.countdown}
      </AppText>
    </View>
  );
}

function BannerCell({
  cell,
  width,
  fontScale,
  dense,
  expanded,
  ref,
  onPress,
}: {
  readonly cell: UsageBannerCell;
  readonly width: number;
  readonly fontScale: number;
  readonly dense?: boolean;
  readonly expanded?: boolean;
  readonly ref?: React.Ref<View>;
  readonly onPress: () => void;
}) {
  const provider = cell.kind === "antigravity" ? "antigravity" : cell.provider;
  const name =
    cell.kind === "antigravity"
      ? `AGY${cell.accountCount > 1 ? ` ×${cell.accountCount}` : ""}`
      : (cell.name ?? "");
  return (
    <Pressable
      ref={ref}
      accessibilityRole="button"
      accessibilityLabel={cell.accessibleLabel}
      accessibilityState={cell.kind === "antigravity" ? { expanded } : undefined}
      className="h-full items-center justify-center px-px active:opacity-60"
      onPress={onPress}
      style={{ width, minHeight: 48 }}
    >
      <View
        className="w-full flex-row items-center justify-center gap-1"
        style={{ height: fontScale >= 1.15 ? 16 * fontScale : 14 }}
      >
        <ProviderIcon provider={provider} size={12} />
        {cell.kind === "antigravity" ? (
          <AppText numberOfLines={1} className="text-[9px] font-t3-medium text-foreground-muted">
            {name}
          </AppText>
        ) : cell.badge !== null ? (
          <AppText className="text-[9px] text-foreground-muted">{cell.badge}</AppText>
        ) : null}
      </View>
      <View
        className="mt-0.5 w-full flex-col justify-center"
        style={{ height: fontScale >= 1.15 ? 52 * fontScale : 26 }}
      >
        {cell.rows.map((row) => (
          <View key={row.slot} className="flex-1 flex-row items-center justify-center">
            <RowValue row={row} fontScale={fontScale} dense={dense ?? false} />
          </View>
        ))}
      </View>
      {cell.staleReasons.length > 0 ? (
        <View className="absolute right-1 top-1 h-1 w-1 rounded-full bg-foreground-muted" />
      ) : null}
    </Pressable>
  );
}

export function UsageLimitBanner(props: { readonly visible: boolean }) {
  const navigation = useNavigation();
  const presentations = useAtomValue(usageBannerPresentationsAtom);
  const { width, fontScale } = useWindowDimensions();
  const [now, setNow] = useState(() => Date.now());
  const [foreground, setForeground] = useState(AppState.currentState === "active");
  const [expanded, setExpanded] = useUsageBannerExpanded();
  const [availableWidth, setAvailableWidth] = useState(0);
  const closeRef = useRef<View>(null);
  const summaryRef = useRef<View>(null);
  const model = useMemo(() => buildUsageBannerModel(presentations, now), [presentations, now]);
  const summary = model.cells.find((cell) => cell.kind === "antigravity");
  const height = usageBannerHeight(fontScale);
  const count = model.cells.length;
  const bannerWidth = availableWidth || width;
  const cellWidth = usageBannerCellWidth(bannerWidth, count);
  const summaryAccountIds = summary?.accounts.map((account) => account.id).join("|") ?? "";
  const accountIds = model.cells.flatMap((cell) =>
    cell.kind === "account" ? [cell.id] : cell.accounts.map((account) => account.id),
  );
  const antigravityIds = summary?.accounts.map((account) => account.id) ?? [];
  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setAvailableWidth((current) => (current === nextWidth ? current : nextWidth));
  };
  const collapse = useCallback(() => {
    setExpanded(false);
    requestAnimationFrame(() => {
      const tag = findNodeHandle(summaryRef.current);
      if (tag !== null) AccessibilityInfo.setAccessibilityFocus(tag);
    });
  }, []);
  const dismissExpansion = useCallback(() => {
    if (!expanded) return false;
    collapse();
    return true;
  }, [collapse, expanded]);
  useHardwareKeyboardCommand("paletteDismiss", dismissExpansion);

  useEffect(() => {
    const subscription = AppState.addEventListener("change", (state) => {
      const active = state === "active";
      setForeground(active);
      if (active) {
        setNow(Date.now());
      } else {
        setExpanded(false);
      }
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!props.visible || !foreground) return;
    const timer = setInterval(() => setNow(Date.now()), MINUTE);
    return () => clearInterval(timer);
  }, [foreground, props.visible]);

  useEffect(() => {
    if (!expanded) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      collapse();
      return true;
    });
    return () => subscription.remove();
  }, [collapse, expanded]);

  useEffect(() => {
    if (props.visible) usageBannerExpansionStore.syncAccounts(accountIds, antigravityIds);
  }, [props.visible, summaryAccountIds, model.cells]);

  const openAccount = (cell: Exclude<UsageBannerCell, { kind: "antigravity" }>) => {
    const row = cell.rows.find((candidate) => candidate.window !== null) ?? cell.rows[0];
    navigation.navigate("SettingsSheet", {
      screen: "SettingsContent",
      params: {
        screen: "SettingsUsageAccount",
        params: {
          accountKey: cell.navigation.accountKey,
          windowId: row.window?.id ?? null,
          windowKind: row.window?.kind ?? null,
          environmentIds: cell.navigation.environmentIds,
          now,
        },
      },
    });
  };

  const toggleExpansion = () => {
    const next = !expanded;
    setExpanded(next);
    if (next && summary) {
      AccessibilityInfo.announceForAccessibility(`${summary.accountCount} Antigravity accounts`);
      requestAnimationFrame(() => {
        const tag = findNodeHandle(closeRef.current);
        if (tag !== null) AccessibilityInfo.setAccessibilityFocus(tag);
      });
    } else {
      requestAnimationFrame(() => {
        const tag = findNodeHandle(summaryRef.current);
        if (tag !== null) AccessibilityInfo.setAccessibilityFocus(tag);
      });
    }
  };

  if (!props.visible || !foreground || count === 0) return null;

  if (expanded && summary) {
    return (
      <View
        onLayout={onLayout}
        className="w-full flex-row items-center border-b border-separator bg-screen"
        style={{ height }}
      >
        <Pressable
          ref={closeRef}
          accessibilityRole="button"
          accessibilityLabel="Collapse Antigravity accounts"
          className="h-full w-12 items-center justify-center active:opacity-60"
          onPress={toggleExpansion}
        >
          <AppText className="text-lg text-foreground">×</AppText>
        </Pressable>
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="h-full flex-row items-center gap-1"
          style={{ flex: 1 }}
        >
          {summary.accounts.map((account) => (
            <BannerCell
              key={account.id}
              cell={account}
              width={Math.max(
                88,
                usageBannerCellWidth(bannerWidth, Math.min(3, summary.accounts.length)),
              )}
              fontScale={fontScale}
              dense={false}
              onPress={() => openAccount(account)}
            />
          ))}
        </ScrollView>
      </View>
    );
  }

  return (
    <View
      onLayout={onLayout}
      className="w-full flex-row items-center justify-center border-b border-separator bg-screen"
      style={{ height }}
    >
      <View
        className="h-full flex-row items-center"
        style={{ width: Math.min(bannerWidth, count * cellWidth + 8 + 2 * (count - 1)) }}
      >
        {model.cells.map((cell, index) => (
          <View
            key={cell.id}
            className="relative h-full flex-row items-center"
            style={{
              marginLeft: index === 0 ? 0 : 2,
              direction: I18nManager.isRTL ? "rtl" : "ltr",
            }}
          >
            {index > 0 && cell.kind === "antigravity" ? (
              <View className="absolute -left-px top-2 bottom-2 w-px bg-separator" />
            ) : null}
            <BannerCell
              cell={cell}
              width={cellWidth}
              fontScale={fontScale}
              dense={count > 3}
              expanded={cell.kind === "antigravity" ? expanded : undefined}
              ref={cell.kind === "antigravity" ? summaryRef : undefined}
              onPress={() => (cell.kind === "antigravity" ? toggleExpansion() : openAccount(cell))}
            />
          </View>
        ))}
      </View>
    </View>
  );
}
