import type { ProviderOptionSelection } from "@t3tools/contracts";
import { getProviderOptionCurrentValue, getProviderOptionDescriptors } from "@t3tools/shared/model";

import type { deriveProviderInstanceEntries } from "../../providerInstances";
import { getProviderModelCapabilities } from "../../providerModels";

/** Effort and reasoning choices for one provider model in a goal's agent list. */
export function ProviderOptionsPicker<
  T extends { model: string; options?: ReadonlyArray<ProviderOptionSelection> | undefined },
>({
  instance,
  onChange,
  target,
}: {
  instance: ReturnType<typeof deriveProviderInstanceEntries>[number];
  onChange: (target: T) => void;
  target: T;
}) {
  const capabilities = getProviderModelCapabilities(
    instance.models,
    target.model,
    instance.driverKind,
  );
  const descriptors = getProviderOptionDescriptors({
    caps: capabilities,
    selections: target.options,
  }).filter(
    (descriptor) =>
      descriptor.id.toLowerCase().includes("effort") ||
      descriptor.id.toLowerCase().includes("reason"),
  );
  if (descriptors.length === 0) return null;

  return (
    <div className="ml-6 flex flex-wrap items-center gap-2 text-2xs">
      {descriptors.map((descriptor) => {
        if (descriptor.type !== "select") return null;
        const currentValue = getProviderOptionCurrentValue(descriptor);
        return (
          <label className="flex items-center gap-1.5" key={descriptor.id}>
            <span className="text-muted-foreground">{descriptor.label}</span>
            <select
              className="rounded-md border border-border bg-background px-1.5 py-1 text-xs"
              onChange={(event) => {
                const options = [
                  ...(target.options ?? []).filter((option) => option.id !== descriptor.id),
                  { id: descriptor.id, value: event.target.value },
                ];
                onChange({ ...target, options });
              }}
              value={typeof currentValue === "string" ? currentValue : ""}
            >
              {descriptor.options.map((option) => (
                <option key={option.id} value={option.id}>
                  {option.label}
                </option>
              ))}
            </select>
          </label>
        );
      })}
    </div>
  );
}
