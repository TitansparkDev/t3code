import type { ModelSelection, ThreadForkErrorReason } from "@t3tools/contracts";
import type { ModelOption } from "../../lib/modelOptions";

export function defaultForkTitle(sourceTitle: string): string {
  const trimmed = sourceTitle.trim();
  if (!trimmed) {
    return "(fork)";
  }
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

export function isThreadForkEligible(params: {
  readonly capabilities?: { readonly threadForking?: boolean } | null;
  readonly thread?: {
    readonly session?: { readonly status?: string } | null;
    readonly latestTurn?: { readonly state?: string } | null;
    readonly messages?: ReadonlyArray<{ readonly streaming?: boolean }>;
  } | null;
}): boolean {
  return isThreadForkSupported(params.capabilities) && !isThreadForkBusy(params.thread);
}

export function resolveDefaultForkOption(
  options: ReadonlyArray<ModelOption>,
  sourceModelSelection?: ModelSelection | null,
): ModelOption | null {
  const usableOptions = options.filter((opt) => !opt.isUnavailable);
  if (usableOptions.length === 0) return null;

  if (sourceModelSelection) {
    const alternate = usableOptions.find(
      (opt) =>
        opt.selection.instanceId !== sourceModelSelection.instanceId ||
        opt.selection.model !== sourceModelSelection.model,
    );
    if (alternate) {
      return alternate;
    }
  }

  return usableOptions[0] ?? null;
}

export function formatForkErrorMessage(error: unknown): string {
  if (!error) return "Failed to fork conversation.";
  if (typeof error === "object" && error !== null) {
    if ("_tag" in error && error._tag === "ThreadForkError") {
      const forkErr = error as { reason?: ThreadForkErrorReason | string; message?: string };
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
