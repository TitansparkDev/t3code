import { describe, expect, it } from "vite-plus/test";

import { isThreadFeedActivityCurrent } from "./thread-feed-activity";

describe("cached thread activity", () => {
  it.each(["empty", "cached", "synchronizing", "deleted"] as const)(
    "does not present a %s projection as live activity",
    (status) => {
      expect(isThreadFeedActivityCurrent(status)).toBe(false);
    },
  );

  it("presents activity as live only after the thread reaches its current sequence", () => {
    expect(isThreadFeedActivityCurrent("live")).toBe(true);
  });
});
