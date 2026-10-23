import { describe, expect, it } from "vite-plus/test";

import { THREAD_WORK_ROW_MIN_HEIGHT } from "../../lib/layout";
import { resolveThreadFeedFixedItemSize } from "./thread-feed-item-size";

describe("thread feed item measurements", () => {
  it.each(["message", "activity-group"] as const)(
    "leaves %s rows to native measurement because their content determines height",
    (type) => {
      expect(resolveThreadFeedFixedItemSize(type)).toBeUndefined();
    },
  );

  it("keeps only compact disclosure rows on fixed measurements", () => {
    expect(resolveThreadFeedFixedItemSize("run-fold")).toBe(42);
    expect(resolveThreadFeedFixedItemSize("work-toggle")).toBe(THREAD_WORK_ROW_MIN_HEIGHT);
  });
});
