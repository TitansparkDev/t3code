export function usageBannerCellWidth(width: number, count: number): number {
  return count === 0 ? 0 : Math.min(88, (width - 8 - 2 * (count - 1)) / count);
}

export function usageBannerHeight(fontScale: number): number {
  return fontScale >= 1.15 ? Math.ceil(72 * fontScale + 8) : 48;
}
