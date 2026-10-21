import { describe, expect, it } from "vite-plus/test";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";
import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import { failureRecoveryGuidance } from "@t3tools/shared/orchestrationV2ThreadError";

describe("ThreadErrorBanner", () => {
  it("gives actionable guidance for each known failure class and an honest fallback", () => {
    const guidance = (failureClass: OrchestrationV2ProviderFailureClass) =>
      failureRecoveryGuidance({
        class: failureClass,
        message: "failed",
        code: null,
        retryable: null,
      });
    expect(guidance("usage_limit")).toContain("Wait for the usage limit");
    expect(guidance("transport_error")).toContain("connection");
    expect(guidance("permission_error")).toContain("permission");
    expect(guidance("validation_error")).toContain("request details");
    expect(guidance("provider_error")).toContain("provider error");
    expect(guidance("unknown")).toContain("Review the error details");
  });
  it("stays hidden after its current error is dismissed", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-a", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(
      shouldShowThreadErrorBanner(
        "env:thread-a",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("reappears when a new error arrives on the same thread", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-b", "Turn failed"));
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", "Provider crashed");

    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        "Provider crashed",
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });

  it("scopes dismissals to the thread that dismissed them", () => {
    dismissThreadErrorBannerForSession(getThreadErrorBannerKey("env:thread-c", "Aborted"));
    const otherThreadKey = getThreadErrorBannerKey("env:other-thread", "Aborted");

    expect(isThreadErrorBannerDismissedForSession(otherThreadKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:other-thread",
        "Aborted",
        isThreadErrorBannerDismissedForSession(otherThreadKey),
      ),
    ).toBe(true);
  });

  it("keeps a dismissal across visiting threads with no error", () => {
    const bannerKey = getThreadErrorBannerKey("env:thread-d", "Aborted");
    dismissThreadErrorBannerForSession(bannerKey);

    expect(shouldShowThreadErrorBanner("env:thread-d", null, false)).toBe(false);
    expect(isThreadErrorBannerDismissedForSession(bannerKey)).toBe(true);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-d",
        "Aborted",
        isThreadErrorBannerDismissedForSession(bannerKey),
      ),
    ).toBe(false);
  });

  it("never shows a null error", () => {
    expect(shouldShowThreadErrorBanner("env:thread-e", null, false)).toBe(false);
  });
});
