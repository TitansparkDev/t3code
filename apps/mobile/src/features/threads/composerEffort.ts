import { getPromptControlledTraits } from "@t3tools/client-runtime/model-traits";
import type { ModelSelection, ProviderOptionDescriptor } from "@t3tools/contracts";

import type { ModelOption } from "../../lib/modelOptions";
import { resolveProviderOptionDescriptors } from "../../lib/providerOptions";
import { selectableChoices } from "./thread-settings-options";

export function composerEffortDescriptor(
  option: ModelOption | null,
  selection: ModelSelection | null,
  prompt: string,
): Extract<ProviderOptionDescriptor, { type: "select" }> | null {
  const descriptors = resolveProviderOptionDescriptors({
    capabilities: option?.capabilities,
    selections: selection?.options,
  });
  const descriptor = getPromptControlledTraits(descriptors, prompt).primarySelectDescriptor;
  return descriptor?.type === "select" && selectableChoices(descriptor).length > 1
    ? descriptor
    : null;
}
