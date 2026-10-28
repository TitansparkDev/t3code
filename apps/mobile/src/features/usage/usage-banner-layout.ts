export const USAGE_BANNER_EDGE_PADDING = 4;
export const USAGE_BANNER_CELL_GAP = 2;
export const USAGE_BANNER_MAX_CELL_WIDTH = 88;
export const USAGE_BANNER_MAX_COLLAPSED_CELLS = 5;
export const USAGE_BANNER_COLLAPSE_CONTROL_WIDTH = 48;

export function usageBannerCellWidth(width: number, count: number): number {
  if (count === 0) return 0;
  const visibleCount = Math.min(count, USAGE_BANNER_MAX_COLLAPSED_CELLS);
  return Math.min(
    USAGE_BANNER_MAX_CELL_WIDTH,
    (width - USAGE_BANNER_EDGE_PADDING * 2 - USAGE_BANNER_CELL_GAP * (visibleCount - 1)) /
      visibleCount,
  );
}

export function usageBannerCollapsedContentWidth(width: number, count: number): number {
  if (count === 0) return 0;
  return (
    usageBannerCellWidth(width, count) * count +
    USAGE_BANNER_EDGE_PADDING * 2 +
    USAGE_BANNER_CELL_GAP * (count - 1)
  );
}

export function usageBannerCollapsedNeedsScroll(count: number): boolean {
  return count > USAGE_BANNER_MAX_COLLAPSED_CELLS;
}

export function usageBannerExpandedCellWidth(width: number, accountCount: number): number {
  if (accountCount === 0) return 0;
  return Math.max(
    USAGE_BANNER_MAX_CELL_WIDTH,
    usageBannerCellWidth(width, Math.min(3, accountCount)),
  );
}

export function usageBannerHeight(fontScale: number): number {
  return fontScale >= 1.15 ? Math.ceil(72 * fontScale + 8) : 48;
}
