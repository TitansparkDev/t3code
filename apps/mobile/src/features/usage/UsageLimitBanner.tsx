import { useAtomValue } from "@effect/atom-react";
import { useNavigation } from "@react-navigation/native";
import * as Haptics from "expo-haptics";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  AccessibilityInfo,
  BackHandler,
  findNodeHandle,
  I18nManager,
  Pressable,
  ScrollView,
  View,
  type LayoutChangeEvent,
  type ViewInstance,
  useWindowDimensions,
} from "react-native";

import { ProviderIcon } from "../../components/ProviderIcon";
import { AppText } from "../../components/ui/AppText";
import { usageBannerPresentationsAtom } from "../../state/usage-banner";
import { useHardwareKeyboardCommand } from "../keyboard/hardwareKeyboardCommands";
import { usageBannerMinuteClock } from "./usage-banner-clock";
import { usageBannerExpansionStore, useUsageBannerExpanded } from "./usage-banner-expansion";
import {
  USAGE_BANNER_COLLAPSE_CONTROL_WIDTH,
  USAGE_BANNER_EDGE_PADDING,
  USAGE_BANNER_CELL_GAP,
  usageBannerCellWidth,
  usageBannerCollapsedContentWidth,
  usageBannerCollapsedNeedsScroll,
  usageBannerExpandedCellWidth,
  usageBannerHeight,
} from "./usage-banner-layout";
import {
  buildUsageBannerModel,
  type UsageBannerAccountCell,
  type UsageBannerCell,
  type UsageBannerRow,
} from "./usage-banner-model";
import {
  usageBannerAccountRouteTarget,
  usageBannerExpandedAccountLabel,
  usageBannerFocusTarget,
  usageBannerRowTone,
  usageBannerStartsProviderGroup,
} from "./usage-banner-presentation";

const UNKNOWN_QUOTA = String.fromCodePoint(0x2014);

function RowValue({
  row,
  fontScale,
  dense,
}: {
  readonly row: UsageBannerRow;
  readonly fontScale: number;
  readonly dense: boolean;
}) {
  const value = row.percent === null ? UNKNOWN_QUOTA : `${row.percent}%`;
  const timerBelow = fontScale >= 1.15;
  const tone = usageBannerRowTone(row);
  const valueTone =
    tone === "danger"
      ? "text-destructive"
      : tone === "warning"
        ? "text-warning-foreground"
        : "text-foreground";
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
        className={`${fontScale >= 1.15 || !dense ? "text-xs" : "text-[11px]"} font-t3-medium tabular-nums ${valueTone}`}
      >
        {value}
      </AppText>
      <AppText
        numberOfLines={1}
        adjustsFontSizeToFit={false}
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
  expandedAccountLabel,
  ref,
  onPress,
}: {
  readonly cell: UsageBannerCell;
  readonly width: number;
  readonly fontScale: number;
  readonly dense?: boolean;
  readonly expanded?: boolean;
  readonly expandedAccountLabel?: string;
  readonly ref?: React.Ref<ViewInstance>;
  readonly onPress: () => void;
}) {
  const provider = cell.kind === "antigravity" ? "antigravity" : cell.provider;
  const summaryName =
    cell.kind === "antigravity"
      ? `AGY${cell.accountCount > 1 ? ` ×${cell.accountCount}` : ""}`
      : null;
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
        {summaryName !== null ? (
          <>
            <AppText numberOfLines={1} className="text-[9px] font-t3-medium text-foreground-muted">
              {summaryName}
            </AppText>
            <AppText className="text-[9px] text-foreground-muted">›</AppText>
          </>
        ) : expandedAccountLabel ? (
          <AppText numberOfLines={1} className="text-[9px] font-t3-medium text-foreground-muted">
            {expandedAccountLabel}
          </AppText>
        ) : cell.kind === "account" && cell.badge !== null ? (
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

function withSelectionFeedback(action: () => void) {
  void Haptics.selectionAsync().catch(() => undefined);
  action();
}

export function UsageLimitBanner(props: { readonly visible: boolean }) {
  const navigation = useNavigation();
  const presentations = useAtomValue(usageBannerPresentationsAtom);
  const { width, fontScale } = useWindowDimensions();
  const clockClientId = useId();
  const now = useSyncExternalStore(
    usageBannerMinuteClock.subscribe,
    usageBannerMinuteClock.getSnapshot,
    usageBannerMinuteClock.getSnapshot,
  );
  const [expanded, setExpanded] = useUsageBannerExpanded();
  const [availableWidth, setAvailableWidth] = useState(0);
  const closeRef = useRef<ViewInstance>(null);
  const summaryRef = useRef<ViewInstance>(null);
  const model = useMemo(() => buildUsageBannerModel(presentations, now), [presentations, now]);
  const summary = model.cells.find((cell) => cell.kind === "antigravity");
  const height = usageBannerHeight(fontScale);
  const count = model.cells.length;
  const bannerWidth = availableWidth || width;
  const cellWidth = usageBannerCellWidth(bannerWidth, count);
  const collapsedContentWidth = usageBannerCollapsedContentWidth(bannerWidth, count);
  const collapsedNeedsScroll = usageBannerCollapsedNeedsScroll(count);
  const { accountIds, antigravityIds } = useMemo(
    () => ({
      accountIds: model.cells.flatMap((cell) =>
        cell.kind === "account" ? [cell.id] : cell.accounts.map((account) => account.id),
      ),
      antigravityIds: summary?.accounts.map((account) => account.id) ?? [],
    }),
    [model.cells, summary],
  );

  const onLayout = (event: LayoutChangeEvent) => {
    const nextWidth = event.nativeEvent.layout.width;
    setAvailableWidth((current) => (current === nextWidth ? current : nextWidth));
  };

  const focusSummary = useCallback(() => {
    requestAnimationFrame(() => {
      const tag = findNodeHandle(summaryRef.current);
      if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
    });
  }, []);

  const collapse = useCallback(() => {
    setExpanded(false);
    focusSummary();
  }, [focusSummary, setExpanded]);

  const dismissExpansion = () => {
    if (!expanded) return false;
    collapse();
    return true;
  };
  useHardwareKeyboardCommand("paletteDismiss", dismissExpansion);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- The shared clock is an external resource whose lifetime follows this mounted visible banner slot.
  useEffect(() => {
    const visible = props.visible && count > 0;
    usageBannerMinuteClock.setVisible(clockClientId, visible);
    return () => usageBannerMinuteClock.remove(clockClientId);
  }, [clockClientId, count, props.visible]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Fresh provider data re-samples wall time without coupling a refresh RPC to rendering.
  useEffect(() => {
    usageBannerMinuteClock.refresh();
    // oxlint-disable-next-line react/exhaustive-effect-dependencies -- Provider identity is intentionally the trigger even when the clock callback does not read the data.
  }, [presentations]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Android Back is a native subscription that exists only while the replacement row is expanded.
  useEffect(() => {
    if (!expanded) return;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      collapse();
      return true;
    });
    return () => subscription.remove();
  }, [collapse, expanded]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- Account-scope removal is external lifecycle state and must collapse an already-mounted expansion.
  useEffect(() => {
    if (props.visible) usageBannerExpansionStore.syncAccounts(accountIds, antigravityIds);
  }, [accountIds, antigravityIds, props.visible]);

  const openAccount = (cell: UsageBannerAccountCell) => {
    const target = usageBannerAccountRouteTarget(cell, now);
    withSelectionFeedback(() => navigation.navigate(target.name, target.params));
  };

  const toggleExpansion = () => {
    const next = !expanded;
    withSelectionFeedback(() => setExpanded(next));
    if (next && summary) {
      AccessibilityInfo.announceForAccessibility(`${summary.accountCount} Antigravity accounts`);
    }
    const focusTarget = usageBannerFocusTarget(next);
    if (focusTarget === "close") {
      requestAnimationFrame(() => {
        const tag = findNodeHandle(closeRef.current);
        if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
      });
    } else {
      focusSummary();
    }
  };

  if (!props.visible || count === 0) return null;

  if (expanded && summary) {
    const expandedCellWidth = usageBannerExpandedCellWidth(bannerWidth, summary.accounts.length);
    return (
      <View
        onLayout={onLayout}
        className="w-full flex-row items-center border-b border-separator bg-screen"
        style={{ height, direction: I18nManager.isRTL ? "rtl" : "ltr" }}
      >
        <Pressable
          ref={closeRef}
          accessibilityRole="button"
          accessibilityLabel="Collapse Antigravity accounts"
          className="h-full items-center justify-center active:opacity-60"
          style={{ width: USAGE_BANNER_COLLAPSE_CONTROL_WIDTH }}
          onPress={toggleExpansion}
        >
          <AppText className="text-lg text-foreground">×</AppText>
        </Pressable>
        <ScrollView
          horizontal
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          contentContainerClassName="h-full flex-row items-center"
          style={{ flex: 1 }}
        >
          {summary.accounts.map((account, index) => (
            <View key={account.id} className="h-full" style={{ marginStart: index === 0 ? 0 : 2 }}>
              <BannerCell
                cell={account}
                width={expandedCellWidth}
                fontScale={fontScale}
                dense={false}
                expandedAccountLabel={usageBannerExpandedAccountLabel(account)}
                onPress={() => openAccount(account)}
              />
            </View>
          ))}
        </ScrollView>
      </View>
    );
  }

  const cells = (
    <View
      className="h-full flex-row items-center"
      style={{
        width: collapsedContentWidth,
        paddingHorizontal: USAGE_BANNER_EDGE_PADDING,
        direction: I18nManager.isRTL ? "rtl" : "ltr",
      }}
    >
      {model.cells.map((cell, index) => {
        const previous = model.cells[index - 1];
        const startsGroup = usageBannerStartsProviderGroup(previous, cell);
        return (
          <View
            key={cell.id}
            className="relative h-full flex-row items-center"
            style={{ marginStart: index === 0 ? 0 : USAGE_BANNER_CELL_GAP }}
          >
            {startsGroup ? (
              <View
                className="absolute top-2 bottom-2 w-px bg-separator"
                style={I18nManager.isRTL ? { right: -1 } : { left: -1 }}
              />
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
        );
      })}
    </View>
  );

  return (
    <View
      onLayout={onLayout}
      className="w-full flex-row items-center justify-center border-b border-separator bg-screen"
      style={{ height }}
    >
      {collapsedNeedsScroll ? (
        <ScrollView
          horizontal
          directionalLockEnabled
          showsHorizontalScrollIndicator={false}
          style={{ width: bannerWidth }}
          contentContainerStyle={{ minWidth: collapsedContentWidth }}
        >
          {cells}
        </ScrollView>
      ) : (
        cells
      )}
    </View>
  );
}
