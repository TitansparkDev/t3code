import { describe, expect, it } from "vitest";

import { mobileApplicationActiveWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("probes just before ten seconds and reconnects at ten seconds", () => {
    expect(mobileApplicationActiveWakeup(0, 9_999)).toBe("application-active-probe");
    expect(mobileApplicationActiveWakeup(0, 10_000)).toBe("application-active-reconnect");
  });
});
