import {
  type ProviderApprovalDecision,
  type ProviderDriverKind,
  type ProviderOptionSelection,
  type ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import * as EffectAcpErrors from "effect-acp/errors";
import type * as EffectAcpSchema from "effect-acp/schema";

import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  type ProviderAdapterError,
} from "../Errors.ts";
import { collectSessionConfigOptionValues } from "./AcpRuntimeModel.ts";

const isAcpProcessExitedError = Schema.is(EffectAcpErrors.AcpProcessExitedError);
const isAcpRequestError = Schema.is(EffectAcpErrors.AcpRequestError);

export function mapAcpToAdapterError(
  provider: ProviderDriverKind,
  threadId: ThreadId,
  method: string,
  error: EffectAcpErrors.AcpError,
): ProviderAdapterError {
  if (isAcpProcessExitedError(error)) {
    return new ProviderAdapterProcessError({
      provider,
      threadId,
      detail: error.message,
      cause: error,
    });
  }
  if (isAcpRequestError(error)) {
    return new ProviderAdapterRequestError({
      provider,
      method,
      detail: error.message,
      cause: error,
    });
  }
  return new ProviderAdapterRequestError({
    provider,
    method,
    detail: error.message,
    cause: error,
  });
}

export function acpPermissionOutcome(decision: ProviderApprovalDecision): string {
  switch (decision) {
    case "acceptForSession":
      return "allow-always";
    case "accept":
      return "allow-once";
    case "decline":
    default:
      return "reject-once";
  }
}

/**
 * Map a non-cancel approval decision to the matching ACP permission option id.
 * Returns `undefined` when the agent does not advertise the requested option.
 */
export function selectAcpPermissionOptionId(
  request: EffectAcpSchema.RequestPermissionRequest,
  decision: Exclude<ProviderApprovalDecision, "cancel">,
): string | undefined {
  const kind =
    decision === "acceptForSession"
      ? "allow_always"
      : decision === "accept"
        ? "allow_once"
        : "reject_once";
  const option = request.options.find((entry) => entry.kind === kind);
  return option?.optionId.trim() || undefined;
}

/** Prefer a session-wide allow, then a one-shot allow, for auto-approval. */
export function selectAcpAutoApprovedPermissionOption(
  request: EffectAcpSchema.RequestPermissionRequest,
): string | undefined {
  return (
    selectAcpPermissionOptionId(request, "acceptForSession") ??
    selectAcpPermissionOptionId(request, "accept")
  );
}

function normalizeOptionToken(value: string): string {
  return value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[^a-zA-Z0-9]+/g, " ")
    .trim()
    .toLowerCase()
    .replace(/\s+/g, "");
}

function optionSemanticToken(value: string): string | undefined {
  const token = normalizeOptionToken(value);
  if (!token) return undefined;
  if (["effort", "reasoning", "reasoningeffort", "thoughtlevel", "variant"].includes(token)) {
    return "effort";
  }
  if (["servicetier", "service", "tier", "priority", "processingtier"].includes(token)) {
    return "serviceTier";
  }
  return token;
}

function isSelectableConfigOption(
  option: EffectAcpSchema.SessionConfigOption,
): option is Extract<EffectAcpSchema.SessionConfigOption, { readonly type: "select" | "boolean" }> {
  return option.type === "select" || option.type === "boolean";
}

function findModelOptionConfig(
  options: ReadonlyArray<EffectAcpSchema.SessionConfigOption>,
  selectionId: string,
): EffectAcpSchema.SessionConfigOption | undefined {
  const selectionToken = optionSemanticToken(selectionId);
  if (!selectionToken) return undefined;

  const candidates = options.filter(
    (option) =>
      isSelectableConfigOption(option) && option.category !== "model" && option.category !== "mode",
  );
  return (
    candidates.find((option) => normalizeOptionToken(option.id) === selectionToken) ??
    candidates.find((option) => normalizeOptionToken(option.name) === selectionToken) ??
    candidates.find(
      (option) =>
        optionSemanticToken(option.id) === selectionToken ||
        optionSemanticToken(option.name) === selectionToken,
    )
  );
}

function resolveConfigOptionValue(
  option: EffectAcpSchema.SessionConfigOption,
  selectedValue: string | boolean,
): string | boolean | undefined {
  if (option.type === "boolean") {
    return typeof selectedValue === "boolean" ? selectedValue : undefined;
  }
  if (typeof selectedValue !== "string") return undefined;

  const allowedValues = collectSessionConfigOptionValues(option);
  if (allowedValues.includes(selectedValue)) return selectedValue;

  const selectedToken = normalizeOptionToken(selectedValue);
  return allowedValues.find((value) => normalizeOptionToken(value) === selectedToken);
}

function configOptionCurrentValueMatches(
  option: EffectAcpSchema.SessionConfigOption,
  value: string | boolean,
): boolean {
  return option.currentValue === value;
}

/**
 * Apply model selections through ACP's advertised session config options.
 * Providers own the config ids, so only options that are present and accept
 * the selected value are sent to the agent.
 */
export function applyAcpModelOptionSelections<E>(input: {
  readonly runtime: Pick<
    import("./AcpSessionRuntime.ts").AcpSessionRuntime["Service"],
    "getConfigOptions" | "setConfigOption"
  >;
  readonly selections: ReadonlyArray<ProviderOptionSelection> | null | undefined;
  readonly mapError: (cause: EffectAcpErrors.AcpError) => E;
}): Effect.Effect<void, E> {
  const selections = input.selections;
  if (!selections || selections.length === 0) {
    return Effect.void;
  }

  return Effect.gen(function* () {
    for (const selection of selections) {
      // ACP may replace the available options after a previous selection, so
      // resolve every option against the latest advertised configuration.
      const configOptions = yield* input.runtime.getConfigOptions;
      const configOption = findModelOptionConfig(configOptions, selection.id);
      if (!configOption) continue;
      const value = resolveConfigOptionValue(configOption, selection.value);
      if (value === undefined || configOptionCurrentValueMatches(configOption, value)) continue;
      yield* input.runtime
        .setConfigOption(configOption.id, value)
        .pipe(Effect.mapError(input.mapError));
    }
  });
}
