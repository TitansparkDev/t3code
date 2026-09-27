import { ProviderInteractionMode, RuntimeMode } from "@t3tools/contracts";
import { ALL_RUNTIME_MODES, RUNTIME_MODE_LABELS } from "@t3tools/shared/providerCapabilities";
import { memo, type ReactNode } from "react";
import { EllipsisIcon } from "lucide-react";
import {
  Menu,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuSeparator as MenuDivider,
  MenuTrigger,
} from "../ui/menu";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { useComposerMenuState } from "./useComposerMenuState";

const RUNTIME_MODE_LABELS_ORDER = ALL_RUNTIME_MODES;

export const CompactComposerControlsMenu = memo(function CompactComposerControlsMenu(props: {
  interactionMode: ProviderInteractionMode;
  runtimeMode: RuntimeMode;
  showInteractionModeToggle: boolean;
  /** Access modes the selected provider can actually enforce. */
  supportedRuntimeModes?: ReadonlyArray<RuntimeMode>;
  traitsMenuContent?: ReactNode;
  size?: "sm" | "xs";
  /**
   * The resting strip keeps this menu mounted out of flow while every block
   * fits inline. Its portaled popup would outlive that transition, so an
   * open menu closes when its trigger hides.
   */
  hidden?: boolean;
  onToggleInteractionMode: () => void;
  onRuntimeModeChange: (mode: RuntimeMode) => void;
}) {
  const composerFloatingLayerProps = useComposerMenuProps();
  const size = props.size ?? "sm";
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const offeredRuntimeModes = RUNTIME_MODE_LABELS_ORDER.filter((mode) =>
    (props.supportedRuntimeModes ?? RUNTIME_MODE_LABELS_ORDER).includes(mode),
  );
  // A thread can sit in a mode the selected provider cannot enforce. Dropping
  // it from the list would leave the trigger naming a value the menu cannot
  // offer, hiding the very reason Send is blocked, so it stays listed as
  // unavailable.
  const currentModeIsUnsupported = !offeredRuntimeModes.includes(props.runtimeMode);

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <MenuTrigger
        render={
          <ComposerControl
            size={size}
            className="shrink-0"
            aria-label="More composer controls"
            data-composer-shortcut={
              props.traitsMenuContent ? "composer.mode composer.effort" : "composer.mode"
            }
          />
        }
      >
        <ComposerControlIcon icon={EllipsisIcon} size={size} />
      </MenuTrigger>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        {props.traitsMenuContent ? (
          <>
            {props.traitsMenuContent}
            <MenuDivider />
          </>
        ) : null}
        {props.showInteractionModeToggle ? (
          <>
            <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Mode</div>
            <MenuRadioGroup
              value={props.interactionMode}
              onValueChange={(value) => {
                if (!value || value === props.interactionMode) return;
                props.onToggleInteractionMode();
              }}
            >
              <MenuRadioItem value="default">Chat</MenuRadioItem>
              <MenuRadioItem value="plan">Plan</MenuRadioItem>
            </MenuRadioGroup>
            <MenuDivider />
          </>
        ) : null}
        <div className="px-2 py-1.5 font-medium text-muted-foreground text-xs">Access</div>
        <MenuRadioGroup
          value={props.runtimeMode}
          onValueChange={(value) => {
            if (!value || value === props.runtimeMode) return;
            props.onRuntimeModeChange(value as RuntimeMode);
          }}
        >
          {offeredRuntimeModes.map((mode) => (
            <MenuRadioItem key={mode} value={mode}>
              {RUNTIME_MODE_LABELS[mode]}
            </MenuRadioItem>
          ))}
          {currentModeIsUnsupported ? (
            <MenuRadioItem value={props.runtimeMode} disabled>
              {RUNTIME_MODE_LABELS[props.runtimeMode]} (unsupported)
            </MenuRadioItem>
          ) : null}
        </MenuRadioGroup>
      </MenuPopup>
    </Menu>
  );
});
