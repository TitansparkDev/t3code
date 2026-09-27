import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type RuntimeMode, type ServerProvider } from "@t3tools/contracts";
import {
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderAttachmentReason,
  getUnsupportedProviderInputReason,
  getUnsupportedProviderModeReason,
} from "@t3tools/shared/providerCapabilities";

import { runtimeModeConfig, runtimeModeOptions } from "./components/chat/runtimeModeConfig.ts";

const CLINE: ServerProvider = {
  instanceId: "cline",
  driver: ProviderDriverKind.make("cline"),
  displayName: "Cline",
  supportedRuntimeModes: ["approval-required", "full-access"],
  supportsImageAttachments: false,
  showInteractionModeToggle: false,
  enabled: true,
  installed: true,
  version: "3.0.65",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: new Date().toISOString(),
  models: [{ slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }],
} as unknown as ServerProvider;

const UNRESTRICTED: ServerProvider = {
  ...CLINE,
  instanceId: "codex",
  driver: ProviderDriverKind.make("codex"),
  displayName: "Codex",
  supportedRuntimeModes: undefined,
  supportsImageAttachments: undefined,
  showInteractionModeToggle: undefined,
} as unknown as ServerProvider;

describe("model picker capability gating", () => {
  it("offers every access mode for a provider that declares no restriction", () => {
    // The composer filters `runtimeModeOptions` by the provider's supported
    // set; an unrestricted provider must keep all of them.
    const offered = runtimeModeOptions.filter((mode) =>
      getProviderSupportedRuntimeModes(UNRESTRICTED).includes(mode),
    );
    expect(offered).toEqual(runtimeModeOptions);
  });

  it("offers only the modes Cline can enforce", () => {
    const offered = runtimeModeOptions.filter((mode) =>
      getProviderSupportedRuntimeModes(CLINE).includes(mode),
    );
    expect(offered).toEqual(["approval-required", "full-access"]);
    // The labels the compact menu renders must exist for every offered mode.
    for (const mode of offered) {
      expect(runtimeModeConfig[mode].label.length).toBeGreaterThan(0);
    }
  });

  it("blocks a turn that asks for a mode Cline cannot enforce", () => {
    const restriction = getUnsupportedProviderInputReason({
      provider: CLINE,
      runtimeMode: "auto" satisfies RuntimeMode,
      interactionMode: "default",
      attachmentCount: 0,
    });
    expect(restriction?.kind).toBe("mode");
    expect(restriction?.reason).toContain("does not support the selected access mode");
  });

  it("blocks image attachments before the user presses Send", () => {
    expect(
      getUnsupportedProviderAttachmentReason({ provider: CLINE, attachmentCount: 1 }),
    ).toContain("does not support image attachments");
    expect(
      getUnsupportedProviderAttachmentReason({ provider: UNRESTRICTED, attachmentCount: 1 }),
    ).toBeNull();
  });

  it("hides the Plan toggle for a provider that cannot switch modes mid-session", () => {
    expect(
      getUnsupportedProviderModeReason({
        provider: CLINE,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    ).toContain("does not support Plan mode");
    expect(
      getUnsupportedProviderModeReason({
        provider: UNRESTRICTED,
        runtimeMode: "approval-required",
        interactionMode: "plan",
      }),
    ).toBeNull();
  });

  it("lets an unrestricted provider run every mode and keep Plan", () => {
    for (const runtimeMode of runtimeModeOptions) {
      expect(
        getUnsupportedProviderModeReason({
          provider: UNRESTRICTED,
          runtimeMode,
          interactionMode: runtimeMode === "full-access" ? "plan" : "default",
        }),
      ).toBeNull();
    }
  });
});
