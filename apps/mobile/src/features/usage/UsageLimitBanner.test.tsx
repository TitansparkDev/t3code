import { describe, expect, it } from "vite-plus/test";

import { usageBannerCellWidth, usageBannerHeight } from "./usage-banner-layout";

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
