import { describe, expect, it } from "vite-plus/test";
import { ProviderDriverKind, type RuntimeMode, type ServerProvider } from "@t3tools/contracts";

import {
  ALL_RUNTIME_MODES,
  getProviderSupportedRuntimeModes,
  getUnsupportedProviderAttachmentReason,
  getUnsupportedProviderInputBannerCopy,
  getUnsupportedProviderInputReason,
  getUnsupportedProviderModeReason,
  providerSupportsFileAttachments,
  providerSupportsImageAttachments,
  providerSupportsRuntimeMode,
  RUNTIME_MODE_LABELS,
  type ProviderCapabilitySnapshot,
} from "./providerCapabilities.ts";

const provider = (
  overrides: Partial<ProviderCapabilitySnapshot> = {},
): ProviderCapabilitySnapshot => ({
  displayName: "Cline",
  driver: ProviderDriverKind.make("cline"),
  ...overrides,
});

const ALL_MODES: ReadonlyArray<RuntimeMode> = ALL_RUNTIME_MODES;

describe("getProviderSupportedRuntimeModes", () => {
  it("treats an absent declaration as every mode", () => {
    expect(getProviderSupportedRuntimeModes(provider())).toEqual(ALL_MODES);
    expect(getProviderSupportedRuntimeModes(null)).toEqual(ALL_MODES);
    // An empty list is not "no restriction"; it would leave the picker with
    // nothing to offer and no way to recover.
    expect(getProviderSupportedRuntimeModes(provider({ supportedRuntimeModes: [] }))).toEqual(
      ALL_MODES,
    );
  });

  it("returns exactly what the provider declares", () => {
    const declared = ["approval-required", "full-access"] as const;
    expect(getProviderSupportedRuntimeModes(provider({ supportedRuntimeModes: declared }))).toEqual(
      ["approval-required", "full-access"],
    );
  });
});

describe("providerSupportsRuntimeMode", () => {
  it("is true for every mode when the provider declares nothing", () => {
    for (const mode of ALL_MODES) {
      expect(providerSupportsRuntimeMode(provider(), mode)).toBe(true);
    }
  });

  it("narrows to the declared set", () => {
    const cline = provider({ supportedRuntimeModes: ["approval-required", "full-access"] });
    expect(providerSupportsRuntimeMode(cline, "approval-required")).toBe(true);
    expect(providerSupportsRuntimeMode(cline, "full-access")).toBe(true);
    expect(providerSupportsRuntimeMode(cline, "auto")).toBe(false);
    expect(providerSupportsRuntimeMode(cline, "auto-accept-edits")).toBe(false);
  });
});

describe("getUnsupportedProviderModeReason", () => {
  it("says nothing when the mode is supported and Plan is off the table", () => {
    expect(
      getUnsupportedProviderModeReason({
        provider: provider({ supportedRuntimeModes: ["approval-required", "full-access"] }),
        runtimeMode: "full-access",
        interactionMode: "default",
      }),
    ).toBeNull();
    expect(
      getUnsupportedProviderModeReason({
        provider: null,
        runtimeMode: "auto",
        interactionMode: "plan",
      }),
    ).toBeNull();
  });

  it("explains an unsupported access mode and names a mode that works", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required", "full-access"] }),
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(reason).toContain("Cline does not support the selected access mode");
    // The narrowest supported mode, so following the advice cannot widen the
    // grant the user already chose.
    expect(reason).toContain(RUNTIME_MODE_LABELS["approval-required"]);
    expect(reason).not.toContain(RUNTIME_MODE_LABELS["full-access"]);
  });

  it("picks the narrowest declared mode when full access is unavailable", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required"] }),
      runtimeMode: "auto",
      interactionMode: "default",
    });
    expect(reason).toContain(RUNTIME_MODE_LABELS["approval-required"]);
    expect(reason).not.toContain(RUNTIME_MODE_LABELS["full-access"]);
  });

  it("reports a current mode the provider cannot enforce", () => {
    // The two pickers drop unsupported modes from the list but must still show
    // the thread's actual value, marked unavailable, or the state blocking Send
    // is invisible where the mode is chosen.
    const cline = provider({ supportedRuntimeModes: ["approval-required", "full-access"] });
    const offered = getProviderSupportedRuntimeModes(cline);
    expect(offered).toEqual(["approval-required", "full-access"]);
    expect(offered.includes("auto")).toBe(false);
    expect(providerSupportsRuntimeMode(cline, "auto")).toBe(false);
    // A mode the provider does enforce is not marked.
    expect(providerSupportsRuntimeMode(cline, "full-access")).toBe(true);
    expect(providerSupportsRuntimeMode(cline, "approval-required")).toBe(true);
  });

  it("treats an empty declaration as unrestricted, not as unrecoverable", () => {
    // Falling back to a hard-coded "Full access" suggestion would name a mode
    // the provider did not declare and leave the picker with no options.
    expect(
      getUnsupportedProviderModeReason({
        provider: provider({ supportedRuntimeModes: [] }),
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    ).toBeNull();
  });

  it("explains an unsupported Plan mode", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({
        supportedRuntimeModes: ["approval-required", "full-access"],
        showInteractionModeToggle: false,
      }),
      runtimeMode: "approval-required",
      interactionMode: "plan",
    });
    expect(reason).toContain("does not support Plan mode");
    expect(reason).toContain("Choose Build");
  });

  it("prefers the access-mode reason over the Plan reason", () => {
    const reason = getUnsupportedProviderModeReason({
      provider: provider({ supportedRuntimeModes: ["approval-required"] }),
      runtimeMode: "auto",
      interactionMode: "plan",
    });
    expect(reason).toContain("access mode");
  });
});

describe("attachment capabilities", () => {
  it("assumes support when the provider says nothing", () => {
    expect(providerSupportsImageAttachments(provider())).toBe(true);
    expect(providerSupportsImageAttachments(null)).toBe(true);
    expect(
      getUnsupportedProviderAttachmentReason({ provider: provider(), attachmentCount: 3 }),
    ).toBeNull();
  });

  it("rejects images for a provider that declares no image support", () => {
    const cline = provider({ supportsImageAttachments: false });
    expect(providerSupportsImageAttachments(cline)).toBe(false);
    const reason = getUnsupportedProviderAttachmentReason({ provider: cline, attachmentCount: 1 });
    expect(reason).toContain("Cline does not support image attachments");
    // A draft with no images is never blocked for this reason.
    expect(
      getUnsupportedProviderAttachmentReason({ provider: cline, attachmentCount: 0 }),
    ).toBeNull();
  });

  it("rejects files for a provider that declares no file support", () => {
    const cline = provider({ supportsFileAttachments: false });
    expect(providerSupportsFileAttachments(cline)).toBe(false);
    const reason = getUnsupportedProviderAttachmentReason({
      provider: cline,
      attachmentCount: 1,
      fileCount: 1,
    });
    // The message must not send the user looking for an image they never added.
    expect(reason).toContain("Cline does not support file attachments");
    expect(reason).not.toContain("image");
  });

  it("keeps image and file support independent", () => {
    // A provider can take a file and still drop an image, so one flag must not
    // stand in for the other: only the attached kind may block the send.
    const filesOnly = provider({ supportsImageAttachments: false });
    expect(providerSupportsFileAttachments(filesOnly)).toBe(true);
    // A file is fine here even though images are not.
    expect(
      getUnsupportedProviderAttachmentReason({
        provider: filesOnly,
        attachmentCount: 1,
        fileCount: 1,
      }),
    ).toBeNull();
    expect(
      getUnsupportedProviderAttachmentReason({ provider: filesOnly, attachmentCount: 1 }),
    ).toContain("image attachments");

    const imagesOnly = provider({ supportsFileAttachments: false });
    expect(providerSupportsImageAttachments(imagesOnly)).toBe(true);
    // An image is fine here even though files are not.
    expect(
      getUnsupportedProviderAttachmentReason({ provider: imagesOnly, attachmentCount: 1 }),
    ).toBeNull();
    expect(
      getUnsupportedProviderAttachmentReason({
        provider: imagesOnly,
        attachmentCount: 1,
        fileCount: 1,
      }),
    ).toContain("file attachments");
  });

  it("names both kinds when a provider supports neither", () => {
    const cline = provider({ supportsImageAttachments: false, supportsFileAttachments: false });
    const reason = getUnsupportedProviderAttachmentReason({
      provider: cline,
      attachmentCount: 3,
      fileCount: 1,
    });
    expect(reason).toContain("Cline does not support attachments");
  });
});

describe("getUnsupportedProviderInputReason", () => {
  const cline = provider({
    supportedRuntimeModes: ["approval-required", "full-access"],
    supportsImageAttachments: false,
  });

  it("returns null when a turn can be sent as composed", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "full-access",
        interactionMode: "default",
        attachmentCount: 0,
      }),
    ).toBeNull();
  });

  it("reports the mode before the attachment", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "auto",
        interactionMode: "default",
        attachmentCount: 2,
      }),
    ).toMatchObject({ kind: "mode" });
  });

  it("reports attachments once the mode is fine", () => {
    expect(
      getUnsupportedProviderInputReason({
        provider: cline,
        runtimeMode: "approval-required",
        interactionMode: "default",
        attachmentCount: 2,
      }),
    ).toMatchObject({ kind: "attachment" });
  });

  it("titles each restriction distinctly", () => {
    expect(getUnsupportedProviderInputBannerCopy({ kind: "mode", reason: "x" }).title).toBe(
      "Provider mode unavailable",
    );
    expect(getUnsupportedProviderInputBannerCopy({ kind: "attachment", reason: "x" }).title).toBe(
      "Image attachments unavailable",
    );
  });
});

describe("capability snapshot compatibility", () => {
  it("reads a real provider snapshot without narrowing it", () => {
    const snapshot = {
      displayName: "Cline",
      driver: "cline",
      supportedRuntimeModes: ["approval-required", "full-access"],
      showInteractionModeToggle: false,
      supportsImageAttachments: false,
      models: [],
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      instanceId: "cline",
    } as unknown as ServerProvider;
    expect(
      getUnsupportedProviderModeReason({
        provider: snapshot,
        runtimeMode: "auto",
        interactionMode: "default",
      }),
    ).toContain("Cline does not support the selected access mode");
  });
});
