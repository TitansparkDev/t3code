import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { ModelOption } from "../../lib/modelOptions";
import { composerEffortDescriptor } from "./composerEffort";

const selection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-next",
  options: [],
};

function modelOption(options: ReadonlyArray<{ id: string; label: string }>): ModelOption {
  return {
    key: "codex:gpt-next",
    label: "GPT Next",
    subtitle: "",
    providerKey: "codex",
    providerLabel: "Codex",
    providerDriver: "codex",
    isDefault: false,
    isLegacy: false,
    capabilities: {
      optionDescriptors: [
        {
          id: "effort",
          label: "Reasoning",
          type: "select",
          options,
          currentValue: options[0]?.id ?? "",
        },
      ],
    },
    selection,
  };
}

describe("composer effort control", () => {
  it("exposes a direct effort choice when the model has multiple levels", () => {
    expect(
      composerEffortDescriptor(
        modelOption([
          { id: "low", label: "Low" },
          { id: "high", label: "High" },
        ]),
        selection,
        "",
      ),
    ).toMatchObject({ id: "effort", label: "Reasoning" });
  });

  it("hides the effort control when the model has no selectable levels", () => {
    expect(
      composerEffortDescriptor(modelOption([{ id: "medium", label: "Medium" }]), selection, ""),
    ).toBeNull();
    expect(composerEffortDescriptor(null, null, "")).toBeNull();
  });
});
