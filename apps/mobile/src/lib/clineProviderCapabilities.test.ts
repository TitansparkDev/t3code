import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type RuntimeMode, type ServerProvider } from "@t3tools/contracts";
import {
  ALL_RUNTIME_MODES,
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderInputReason,
  providerSupportsImageAttachments,
} from "@t3tools/shared/providerCapabilities";

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

describe("mobile provider capability gating", () => {
  it("offers Cline only the access modes it can enforce", () => {
    const supported = getProviderSupportedRuntimeModes(CLINE);
    expect(supported).toEqual(["approval-required", "full-access"]);
    // The settings list renders a label for every mode it is asked to show, so
    // a filtered mode must never be one the picker cannot name.
    for (const mode of supported) {
      expect(ALL_RUNTIME_MODES).toContain(mode);
    }
  });

  it("blocks a mobile send that asks for an unenforceable access mode", () => {
    const restriction = getUnsupportedProviderInputReason({
      provider: CLINE,
      runtimeMode: "auto" as RuntimeMode,
      interactionMode: "default",
      attachmentCount: 0,
    });
    expect(restriction?.kind).toBe("mode");
  });

  it("hides the image option for a provider that drops non-text content", () => {
    expect(providerSupportsImageAttachments(CLINE)).toBe(false);
  });

  it("blocks a mobile send that carries an image to a provider that drops it", () => {
    const restriction = getUnsupportedProviderInputReason({
      provider: CLINE,
      runtimeMode: "full-access",
      interactionMode: "default",
      attachmentCount: 1,
    });
    expect(restriction?.kind).toBe("attachment");
  });
});
