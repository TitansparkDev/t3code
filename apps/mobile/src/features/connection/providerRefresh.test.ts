import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/unstable/reactivity";
import { describe, expect, it, vi } from "vite-plus/test";
import type { AtomCommandResult } from "@t3tools/client-runtime/state/runtime";

import {
  canRefreshProviders,
  createProviderRefreshRunner,
  providerRefreshAlert,
} from "./providerRefresh";

describe("provider refresh connection action", () => {
  it.each([
    ["available", false],
    ["offline", false],
    ["connecting", false],
    ["reconnecting", false],
    ["connected", true],
    ["error", false],
  ] as const)("allows refresh only for %s environments", (connectionState, expected) => {
    expect(canRefreshProviders(connectionState)).toBe(expected);
  });

  it("reports success and ordinary failures", () => {
    expect(providerRefreshAlert(AsyncResult.success(undefined))).toEqual({
      title: "Providers refreshed",
      message: "Provider availability and model metadata are up to date.",
    });
    expect(
      providerRefreshAlert(AsyncResult.failure(Cause.fail(new Error("provider unavailable")))),
    ).toEqual({
      title: "Could not refresh providers",
      message: "provider unavailable",
    });
  });

  it("does not report an alert for interrupted commands", () => {
    expect(providerRefreshAlert(AsyncResult.failure(Cause.interrupt(1)))).toBeNull();
  });

  it("ignores repeated taps while the first refresh is pending", async () => {
    let resolveRefresh!: (result: AtomCommandResult<unknown, unknown>) => void;
    const refresh = vi.fn(
      (): Promise<AtomCommandResult<unknown, unknown>> =>
        new Promise<AtomCommandResult<unknown, unknown>>((resolve) => {
          resolveRefresh = resolve;
        }),
    );
    const alert = vi.fn();
    const runRefresh = createProviderRefreshRunner(refresh, alert);

    const first = runRefresh();
    const second = runRefresh();
    expect(first).not.toBeNull();
    expect(second).toBeNull();
    expect(refresh).toHaveBeenCalledOnce();

    if (!first) throw new Error("Expected the first refresh to start.");
    resolveRefresh(AsyncResult.success(undefined));
    await first;
    expect(alert).toHaveBeenCalledOnce();

    const third = runRefresh();
    expect(third).not.toBeNull();
    if (!third) throw new Error("Expected a refresh after the first one settled.");
    resolveRefresh(AsyncResult.success(undefined));
    await third;
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(alert).toHaveBeenCalledTimes(2);
  });
});
