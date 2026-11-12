import type { ModelSelection } from "@t3tools/contracts";
import { getProviderOptionCurrentLabel } from "@t3tools/shared/model";
import type { ModelOption } from "../lib/modelOptions";
import { composerEffortDescriptor } from "../features/threads/composerEffort";
import { AppText as Text } from "./ui/AppText";
import { ComposerInlineControl } from "./ComposerToolbar";
import { ProviderIcon, ProviderInstanceIcon, providerInstanceNameLabel } from "./ProviderIcon";

export function ComposerModelControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly surfaceColor: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  readonly onPress: () => void;
}) {
  const badge = props.modelOption?.providerBadge;
  const label = props.modelOption?.label ?? props.selection?.model ?? "Choose model";
  const providerNameLabel = badge
    ? providerInstanceNameLabel({
        provider: props.modelOption?.providerDriver,
        iconUrl: props.modelOption?.providerIconUrl,
        displayName: badge.displayName,
        showBadge: badge.showBadge,
      })
    : null;
  const shortLabel = props.modelOption?.shortName ?? label;
  return (
    <ComposerInlineControl
      accessibilityLabel={["Model", label, badge?.showBadge ? badge.displayName : null]
        .filter(Boolean)
        .join(", ")}
      size={props.size}
      disabled={props.disabled}
      emphasized
      renderIcon={(size) =>
        badge?.showBadge ? (
          <ProviderInstanceIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            displayName={badge.displayName}
            accentColor={badge.accentColor}
            showBadge
            surfaceColor={props.surfaceColor}
            size={size}
          />
        ) : (
          <ProviderIcon
            iconUrl={props.modelOption?.providerIconUrl}
            provider={props.modelOption?.providerDriver}
            size={size}
          />
        )
      }
      label={providerNameLabel ?? shortLabel}
      labelEllipsizeMode={providerNameLabel ? "middle" : undefined}
      iconOnly={props.iconOnly}
      suffixWidth={providerNameLabel ? 96 : undefined}
      suffix={
        providerNameLabel ? (
          <Text className="text-xs text-foreground-muted" numberOfLines={1}>
            {shortLabel}
          </Text>
        ) : undefined
      }
      maxWidth="100%"
      onPress={props.onPress}
    />
  );
}

export function ComposerEffortControl(props: {
  readonly modelOption: ModelOption | null;
  readonly selection: ModelSelection | null;
  readonly reportedSelection?: ModelSelection | null | undefined;
  readonly prompt: string;
  readonly disabled?: boolean;
  readonly size?: "regular" | "large";
  readonly iconOnly?: boolean;
  readonly onPress: (descriptorId: string) => void;
}) {
  const descriptor = composerEffortDescriptor(props.modelOption, props.selection, props.prompt);
  if (!descriptor) return null;
  const value =
    getProviderOptionCurrentLabel(descriptor, props.selection, props.reportedSelection) ??
    "Default";
  return (
    <ComposerInlineControl
      accessibilityLabel={`${descriptor.label}: ${value}`}
      size={props.size}
      disabled={props.disabled}
      icon="slider.horizontal.3"
      label={value}
      iconOnly={props.iconOnly}
      maxWidth={120}
      onPress={() => props.onPress(descriptor.id)}
    />
  );
}
