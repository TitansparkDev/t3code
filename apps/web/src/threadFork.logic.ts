import {
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type ServerProvider,
  type ThreadForkErrorReason,
  DEFAULT_UNIFIED_SETTINGS,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { deriveProviderInstanceEntries, isProviderInstancePickerReady } from "./providerInstances";
import { getAppModelOptionsForInstance } from "./modelSelection";

export interface ForkModelOption {
  readonly instanceId: ProviderInstanceId;
  readonly driverKind: ProviderDriverKind;
  readonly providerDisplayName: string;
  readonly modelSlug: string;
  readonly modelName: string;
  readonly isCurrent: boolean;
}

export function defaultForkTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  if (trimmed.endsWith("(fork)")) {
    return trimmed;
  }
  return `${trimmed} (fork)`;
}

export function isThreadForkSupported(
  capabilities?: { readonly threadForking?: boolean } | null,
): boolean {
  return capabilities?.threadForking === true;
}

export function isThreadForkBusy(
  thread:
    | {
        readonly session?: { readonly status?: string } | null;
        readonly latestTurn?: { readonly state?: string } | null;
        readonly messages?: ReadonlyArray<{ readonly streaming?: boolean }>;
      }
    | null
    | undefined,
): boolean {
  if (!thread) return false;
  const isSessionRunning =
    thread.session?.status === "running" || thread.session?.status === "starting";
  const isTurnRunning =
    thread.latestTurn?.state === "running" || thread.latestTurn?.state === "pending";
  const isStreaming = thread.messages?.some((m) => m.streaming) ?? false;
  return isSessionRunning || isTurnRunning || isStreaming;
}

export function resolveForkModelOptions(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings?: UnifiedSettings;
  readonly sourceModelSelection?: ModelSelection | null;
}): ReadonlyArray<ForkModelOption> {
  const { providers, sourceModelSelection } = input;
  const effectiveSettings: UnifiedSettings = input.settings ?? DEFAULT_UNIFIED_SETTINGS;
  const entries = deriveProviderInstanceEntries(providers).filter(
    (entry) =>
      isProviderInstancePickerReady(entry) &&
      entry.installed &&
      entry.snapshot.auth.status === "authenticated",
  );
  const options: ForkModelOption[] = [];

  for (const entry of entries) {
    const modelOptions = getAppModelOptionsForInstance(effectiveSettings, entry);
    for (const model of modelOptions) {
      if (model.isUnavailable) continue;
      const isCurrent =
        sourceModelSelection != null &&
        entry.instanceId === sourceModelSelection.instanceId &&
        model.slug === sourceModelSelection.model;

      options.push({
        instanceId: entry.instanceId,
        driverKind: entry.driverKind,
        providerDisplayName: entry.displayName,
        modelSlug: model.slug,
        modelName: model.name || model.slug,
        isCurrent,
      });
    }
  }

  return options;
}

export function hasAvailableForkModel(input: {
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly settings?: UnifiedSettings;
  readonly currentSelection?: ModelSelection | null;
}): boolean {
  const options = resolveForkModelOptions({
    providers: input.providers,
    ...(input.settings ? { settings: input.settings } : {}),
    ...(input.currentSelection ? { sourceModelSelection: input.currentSelection } : {}),
  });
  return options.length > 0;
}

export function resolveDefaultForkSelection(
  options: ReadonlyArray<ForkModelOption>,
  sourceModelSelection?: ModelSelection | null,
): ForkModelOption | null {
  if (options.length === 0) return null;
  const alternate = options.find((opt) => !opt.isCurrent);
  return alternate ?? options[0] ?? null;
}

export function formatForkErrorMessage(error: unknown): string {
  if (!error) return "Failed to fork conversation.";
  if (typeof error === "object" && error !== null) {
    if ("_tag" in error && error._tag === "ThreadForkError") {
      const forkErr = error as { reason?: ThreadForkErrorReason; message?: string };
      switch (forkErr.reason) {
        case "source_busy":
          return "The source thread is currently busy. Please wait for the current turn to complete.";
        case "provider_unavailable":
          return "The selected provider or model is unavailable or unauthenticated.";
        case "target_conflict":
          return "A thread with this target ID already exists or conflicts with an existing thread.";
        case "transcript_too_large":
          return "The conversation transcript exceeds the maximum size for forking.";
        case "source_not_found":
          return "Source thread was not found.";
        case "project_not_found":
          return "Project was not found.";
        case "invalid_request":
          return forkErr.message || "Invalid fork request.";
        default:
          return forkErr.message || "Failed to fork conversation.";
      }
    }
    if ("message" in error && typeof error.message === "string") {
      const msg = error.message;
      if (msg.toLowerCase().includes("transcript") && msg.toLowerCase().includes("large")) {
        return "The conversation transcript exceeds the maximum size for forking.";
      }
      if (msg.toLowerCase().includes("busy")) {
        return "The source thread is currently busy. Please wait for the current turn to complete.";
      }
      if (msg.toLowerCase().includes("provider") && msg.toLowerCase().includes("unavail")) {
        return "The selected provider or model is unavailable or unauthenticated.";
      }
      if (msg.toLowerCase().includes("conflict")) {
        return "Target thread conflicts with an existing thread.";
      }
      return msg;
    }
  }
  return error instanceof Error ? error.message : "Failed to fork conversation.";
}
