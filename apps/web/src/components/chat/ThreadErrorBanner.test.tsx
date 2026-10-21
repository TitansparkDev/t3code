import { describe, expect, it } from "vite-plus/test";

import type { OrchestrationV2ProviderFailureClass } from "@t3tools/contracts";
import { failureRecoveryGuidance } from "@t3tools/shared/orchestrationV2ThreadError";

import {
  dismissThreadErrorBannerForSession,
  getThreadErrorBannerKey,
  getThreadErrorBannerMessage,
  isThreadErrorBannerDismissedForSession,
  shouldShowThreadErrorBanner,
} from "./ThreadErrorBanner";

describe("failure recovery guidance", () => {
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
});

describe("getThreadErrorBannerMessage", () => {
  it("extracts a readable nested message without trimming its whitespace", () => {
    const message =
      "  This model is not supported with a ChatGPT account.\nChoose another model.  ";
    const error = ` \n${JSON.stringify({ error: { message, code: "unsupported_model" } })}\t `;

    expect(getThreadErrorBannerMessage(error)).toBe(message);
  });

  it("keeps the diagnostics when the nested message is blank", () => {
    const error = JSON.stringify({ error: { message: " \n\t ", code: "unsupported_model" } });

    expect(getThreadErrorBannerMessage(error)).toBe(error);
  });
});

describe("ThreadErrorBanner", () => {
  it("reappears for different diagnostics with the same headline on the same thread", () => {
    const firstError = JSON.stringify({ error: { message: "Turn failed", code: "first" } });
    const secondError = JSON.stringify({ error: { message: "Turn failed", code: "second" } });
    const dismissedKey = getThreadErrorBannerKey("env:thread-b", firstError);
    dismissThreadErrorBannerForSession(dismissedKey);
    const newErrorKey = getThreadErrorBannerKey("env:thread-b", secondError);

    expect(isThreadErrorBannerDismissedForSession(dismissedKey)).toBe(true);
    expect(isThreadErrorBannerDismissedForSession(newErrorKey)).toBe(false);
    expect(
      shouldShowThreadErrorBanner(
        "env:thread-b",
        secondError,
        isThreadErrorBannerDismissedForSession(newErrorKey),
      ),
    ).toBe(true);
  });
});
