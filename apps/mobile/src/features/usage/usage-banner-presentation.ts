import type { UsageBannerAccountCell, UsageBannerCell, UsageBannerRow } from "./usage-banner-model";

export type UsageBannerRowTone = "neutral" | "warning" | "danger";
export type UsageBannerFocusTarget = "summary" | "close";

export function usageBannerFocusTarget(expanded: boolean): UsageBannerFocusTarget {
  return expanded ? "close" : "summary";
}

export function usageBannerRowTone(row: UsageBannerRow): UsageBannerRowTone {
  if (row.percent === null || row.staleReasons.length > 0) return "neutral";
  if (row.percent === 0) return "danger";
  return row.percent <= 20 ? "warning" : "neutral";
}

function usageBannerProviderGroup(cell: UsageBannerCell): string {
  return cell.kind === "antigravity" ? "antigravity" : cell.provider;
}

export function usageBannerStartsProviderGroup(
  previous: UsageBannerCell | undefined,
  current: UsageBannerCell,
): boolean {
  return (
    previous !== undefined &&
    usageBannerProviderGroup(previous) !== usageBannerProviderGroup(current)
  );
}

export function usageBannerExpandedAccountLabel(cell: UsageBannerAccountCell): string {
  return cell.badge === null ? "A" : `A${cell.badge}`;
}

export interface UsageBannerAccountRouteTarget {
  readonly name: "SettingsUsageAccount";
  readonly params: {
    readonly accountKey: string;
    readonly windowId: string | null;
    readonly windowKind: UsageBannerRow["window"] extends infer Window
      ? Window extends { readonly kind: infer Kind }
        ? Kind | null
        : null
      : null;
    readonly environmentIds: readonly string[] | null;
    readonly now: number;
  };
}

export function usageBannerAccountRouteTarget(
  cell: UsageBannerAccountCell,
  now: number,
): UsageBannerAccountRouteTarget {
  const row = cell.rows.find((candidate) => candidate.window !== null) ?? cell.rows[0];
  return {
    name: "SettingsUsageAccount",
    params: {
      accountKey: cell.navigation.accountKey,
      windowId: row.window?.id ?? null,
      windowKind: row.window?.kind ?? null,
      environmentIds: cell.navigation.environmentIds,
      now,
    },
  };
}
