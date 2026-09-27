/**
 * Provider capability gating, shared by web and mobile.
 *
 * Some provider CLIs can only honor part of what T3 Code offers — a single
 * approve-everything tool policy, no image ingest, no mid-session mode switch.
 * The server declares that on the `ServerProvider` snapshot
 * (`supportedRuntimeModes`, `supportsImageAttachments`,
 * `supportsFileAttachments`, `showInteractionModeToggle`), and these helpers are
 * the one place clients ask
 * what that means. Keeping them here is the point: a provider-shaped branch in a
 * composer is how capability work turns into scattered `driver === "..."` checks
 * that drift between surfaces.
 *
 * @module shared/providerCapabilities
 */
import type { ProviderInteractionMode, RuntimeMode, ServerProvider } from "@t3tools/contracts";

/** The subset of a provider snapshot the gating rules read. */
export type ProviderCapabilitySnapshot = Pick<
  ServerProvider,
  | "displayName"
  | "driver"
  | "supportedRuntimeModes"
  | "showInteractionModeToggle"
  | "supportsImageAttachments"
  | "supportsFileAttachments"
>;

/** The narrowest shape the mode helpers need, for callers holding only a list. */
export type RuntimeModeCapabilitySnapshot = Pick<
  ProviderCapabilitySnapshot,
  "supportedRuntimeModes"
>;

/**
 * Every access mode, in the order the access-mode picker lists them.
 *
 * The `AssertNever` alias below is what keeps this list honest: adding a mode to
 * the contract without listing it here fails to compile, instead of quietly
 * leaving the new mode unavailable on every provider that has not narrowed its
 * own set.
 */
const RUNTIME_MODE_ORDER = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
] as const satisfies ReadonlyArray<RuntimeMode>;
type AssertNever<T extends never> = T;
type _AllRuntimeModesListed = AssertNever<
  Exclude<RuntimeMode, (typeof RUNTIME_MODE_ORDER)[number]>
>;

export const ALL_RUNTIME_MODES: ReadonlyArray<RuntimeMode> = RUNTIME_MODE_ORDER;

export const RUNTIME_MODE_LABELS: Readonly<Record<RuntimeMode, string>> = {
  "approval-required": "Supervised",
  "auto-accept-edits": "Auto-accept edits",
  auto: "Auto",
  "full-access": "Full access",
};

function providerLabel(provider: ProviderCapabilitySnapshot | null | undefined): string {
  return provider?.displayName?.trim() || "This provider";
}

/**
 * Access modes the provider can enforce. An absent list means "all of them",
 * which stays true for every provider that has not declared a narrower set.
 */
export function getProviderSupportedRuntimeModes(
  provider: RuntimeModeCapabilitySnapshot | null | undefined,
): ReadonlyArray<RuntimeMode> {
  const declared = provider?.supportedRuntimeModes;
  return declared && declared.length > 0 ? declared : ALL_RUNTIME_MODES;
}

export function providerSupportsRuntimeMode(
  provider: RuntimeModeCapabilitySnapshot | null | undefined,
  runtimeMode: RuntimeMode,
): boolean {
  return getProviderSupportedRuntimeModes(provider).includes(runtimeMode);
}

/**
 * The mode the picker should steer toward: the tightest grant the provider can
 * actually enforce.
 *
 * Deliberately the narrowest, not the widest. Pointing a user at Full access to
 * unblock a send would widen the grant to make the error go away, which is the
 * opposite of what an unsupported-mode warning is for.
 */
function narrowestRuntimeMode(supported: ReadonlyArray<RuntimeMode>): RuntimeMode | undefined {
  // `ALL_RUNTIME_MODES` runs narrowest-first, so the first supported entry is
  // the tightest one available.
  return ALL_RUNTIME_MODES.find((mode) => supported.includes(mode));
}

function unsupportedRuntimeModeReason(
  provider: ProviderCapabilitySnapshot,
  supported: ReadonlyArray<RuntimeMode>,
): string {
  const label = providerLabel(provider);
  const suggestion = narrowestRuntimeMode(supported);
  if (!suggestion) {
    return `${label} does not declare any supported access mode. Re-check the provider in Settings.`;
  }
  return `${label} does not support the selected access mode. Choose ${RUNTIME_MODE_LABELS[suggestion]} to continue.`;
}

function planUnsupportedReason(provider: ProviderCapabilitySnapshot): string {
  return `${providerLabel(provider)} does not support Plan mode. Choose Build to continue.`;
}

export function providerShowsInteractionModeToggle(
  provider: ProviderCapabilitySnapshot | null | undefined,
  interactionMode: ProviderInteractionMode | undefined,
): boolean {
  if (interactionMode === "plan") return true;
  return provider?.showInteractionModeToggle !== false;
}

/**
 * The reason a turn cannot be sent as composed, or `null` when it can.
 * Access mode wins over Plan, which wins over attachments, so the message names
 * the first thing the user has to change.
 */
export function getUnsupportedProviderModeReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
}): string | null {
  const { provider, runtimeMode, interactionMode } = input;
  if (!provider) return null;
  // Never empty: an absent or empty declaration means "all of them". The
  // no-modes-declared case therefore cannot be reached here, and the composer
  // always has at least one access mode to steer toward.
  const supported = getProviderSupportedRuntimeModes(provider);
  if (!supported.includes(runtimeMode)) {
    return unsupportedRuntimeModeReason(provider, supported);
  }
  if (interactionMode === "plan" && provider.showInteractionModeToggle === false) {
    return planUnsupportedReason(provider);
  }
  return null;
}

export function providerSupportsImageAttachments(
  provider: ProviderCapabilitySnapshot | null | undefined,
): boolean {
  return provider?.supportsImageAttachments !== false;
}

/**
 * Files are a separate question from images: a provider can take a file and
 * still drop an image, so the two flags are never inferred from each other.
 */
export function providerSupportsFileAttachments(
  provider: ProviderCapabilitySnapshot | null | undefined,
): boolean {
  return provider?.supportsFileAttachments !== false;
}

/**
 * The reason the composed attachments cannot be sent, or `null`.
 *
 * Counts are separate so the message names what the user actually has to
 * remove. Reporting "images" for a file-only draft would send the user looking
 * for an image they never attached.
 */
export function getUnsupportedProviderAttachmentReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly attachmentCount: number;
  readonly fileCount?: number;
}): string | null {
  const imageCount = Math.max(0, input.attachmentCount - (input.fileCount ?? 0));
  if (input.attachmentCount === 0) return null;
  const label = providerLabel(input.provider);
  const imagesUnsupported = imageCount > 0 && !providerSupportsImageAttachments(input.provider);
  const filesUnsupported =
    (input.fileCount ?? 0) > 0 && !providerSupportsFileAttachments(input.provider);
  if (imagesUnsupported && filesUnsupported) {
    return `${label} does not support attachments. Remove them to continue.`;
  }
  if (filesUnsupported) {
    return `${label} does not support file attachments. Remove the files to continue.`;
  }
  if (imagesUnsupported) {
    return `${label} does not support image attachments. Remove the images to continue.`;
  }
  return null;
}

export type UnsupportedProviderInputKind = "mode" | "attachment";

/** Single source for the composer's send gate and its banner copy. */
export function getUnsupportedProviderInputReason(input: {
  readonly provider: ProviderCapabilitySnapshot | null | undefined;
  readonly runtimeMode: RuntimeMode;
  readonly interactionMode: ProviderInteractionMode | undefined;
  readonly attachmentCount: number;
  readonly fileCount?: number;
}): { readonly kind: UnsupportedProviderInputKind; readonly reason: string } | null {
  const modeReason = getUnsupportedProviderModeReason(input);
  if (modeReason !== null) return { kind: "mode", reason: modeReason };
  const attachmentReason = getUnsupportedProviderAttachmentReason(input);
  if (attachmentReason !== null) return { kind: "attachment", reason: attachmentReason };
  return null;
}

export function getUnsupportedProviderInputBannerCopy(restriction: {
  readonly kind: UnsupportedProviderInputKind;
  readonly reason: string;
}): { readonly title: string } {
  return {
    title:
      restriction.kind === "attachment"
        ? "Image attachments unavailable"
        : "Provider mode unavailable",
  };
}
