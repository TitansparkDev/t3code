import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

const mocks = vi.hoisted(() => ({
  os: "android",
  native: null as {
    configure?: ReturnType<typeof vi.fn>;
    wake?: ReturnType<typeof vi.fn>;
    addListener?: ReturnType<typeof vi.fn>;
    wakeSubscriptionRemove: ReturnType<typeof vi.fn>;
  } | null,
  requireModule: vi.fn(),
}));

vi.mock("expo", () => ({
  EventEmitter: class {
    addListener() {
      return { remove: vi.fn() };
    }
  },
  requireOptionalNativeModule: mocks.requireModule,
}));
vi.mock("react-native", () => ({
  Platform: {
    get OS() {
      return mocks.os;
    },
  },
}));

beforeEach(() => {
  vi.resetModules();
  mocks.os = "android";
  mocks.native = {
    configure: vi.fn(),
    wake: vi.fn(),
    addListener: vi.fn(() => ({ remove: mocks.native?.wakeSubscriptionRemove })),
    wakeSubscriptionRemove: vi.fn(),
  };
  mocks.requireModule.mockReset().mockImplementation(() => mocks.native);
});

describe("Android background connection lifecycle", () => {
  it("enables only while Android is backgrounded with saved environments", async () => {
    const module = await import("./android-background");
    expect(module.shouldEnableAndroidBackgroundConnection("active", 2)).toBe(false);
    expect(module.shouldEnableAndroidBackgroundConnection("background", 0)).toBe(false);
    expect(module.shouldEnableAndroidBackgroundConnection("background", 2)).toBe(true);
    expect(module.shouldEnableAndroidBackgroundConnection("inactive", 1)).toBe(true);
    module.configureAndroidBackgroundConnection(true);
    module.wakeAndroidBackgroundConnection();
    expect(mocks.native?.configure).toHaveBeenCalledWith(true);
    expect(mocks.native?.wake).toHaveBeenCalledOnce();

    const listener = vi.fn();
    const remove = module.subscribeAndroidBackgroundConnectionWake(listener);
    expect(mocks.native?.addListener).toHaveBeenCalledWith("onWake", listener);
    remove();
    expect(mocks.native?.wakeSubscriptionRemove).toHaveBeenCalledOnce();
  });

  it("is a no-op on iOS and when an older Android binary lacks the module", async () => {
    mocks.os = "ios";
    const ios = await import("./android-background");
    expect(ios.supportsAndroidBackgroundConnection()).toBe(false);
    expect(ios.shouldEnableAndroidBackgroundConnection("background", 2)).toBe(false);
    expect(() => ios.configureAndroidBackgroundConnection(true)).not.toThrow();
    expect(() => ios.wakeAndroidBackgroundConnection()).not.toThrow();

    vi.resetModules();
    mocks.os = "android";
    mocks.native = null;
    mocks.requireModule.mockReset().mockReturnValue(null);
    const missing = await import("./android-background");
    expect(missing.supportsAndroidBackgroundConnection()).toBe(false);
    expect(() => missing.configureAndroidBackgroundConnection(false)).not.toThrow();
    expect(() => missing.wakeAndroidBackgroundConnection()).not.toThrow();
  });
});
