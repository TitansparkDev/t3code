import { describe, expect, it } from "vitest";

import { mobileApplicationActiveWakeup, mobileNativeWakeup } from "./app-state-wakeups";

describe("mobileApplicationActiveWakeup", () => {
  it("probes just before ten seconds and reconnects at ten seconds", () => {
    expect(mobileApplicationActiveWakeup(0, 9_999)).toBe("application-active-probe");
    expect(mobileApplicationActiveWakeup(0, 10_000)).toBe("application-active-reconnect");
  });
});

describe("mobileNativeWakeup", () => {
  it.each([
    ["background", null, 60_000, null],
    ["inactive", 0, 60_000, null],
    ["unknown", 0, 60_000, null],
    ["active", 51_000, 60_999, null],
    ["active", 50_000, 60_000, "native-wake"],
  ] as const)("for app state %s, returns %s", (appState, foregroundedAtMs, nowMs, expected) => {
    expect(mobileNativeWakeup(appState, foregroundedAtMs, nowMs)).toBe(expected);
  });
});
