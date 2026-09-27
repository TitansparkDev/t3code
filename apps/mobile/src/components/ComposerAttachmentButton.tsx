import type { MenuAction } from "@react-native-menu/menu";
import { Pressable } from "react-native";

import { useAndroidControlSizing } from "./useAndroidControlSizing";
import { SymbolView } from "./AppSymbol";
import { ControlPillMenu } from "./ControlPill";

const ATTACHMENT_MENU_ACTIONS: MenuAction[] = [
  { id: "photos", title: "Photo Library", image: "photo" },
  { id: "files", title: "Choose Files", image: "folder" },
];

export function ComposerAttachmentButton(props: {
  readonly disabled?: boolean;
  readonly supportsFiles: boolean;
  /**
   * Whether the selected provider can consume images in a prompt. Absent means
   * yes. Some agents advertise image prompts and then drop every non-text
   * block, so offering the picker would collect a photo that never arrives.
   */
  readonly supportsImages?: boolean;
  readonly onPickMedia: () => Promise<void>;
  readonly onPickFiles: () => Promise<void>;
}) {
  const { scale } = useAndroidControlSizing();
  const supportsImages = props.supportsImages !== false;
  // Both capabilities gate the menu, not just images: a server without file
  // attachments must not be offered a file picker either.
  const actions = ATTACHMENT_MENU_ACTIONS.filter(
    (action) =>
      (action.id !== "photos" || supportsImages) && (action.id !== "files" || props.supportsFiles),
  );
  const runAction = (id: string) => () => {
    if (id === "photos") {
      void props.onPickMedia();
    } else if (id === "files") {
      void props.onPickFiles();
    }
  };
  const button = (
    <Pressable
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      accessibilityState={{ disabled: props.disabled }}
      className="size-[44px] shrink-0 items-center justify-center rounded-full active:opacity-70 disabled:opacity-50"
      disabled={props.disabled}
      // One remaining action runs directly, and it has to be the action that
      // survived the filter rather than a hard-coded media pick.
      onPress={actions.length > 1 ? undefined : runAction(actions[0]?.id ?? "")}
    >
      <SymbolView
        name="plus"
        size={Math.round(20 * scale)}
        weight="regular"
        tintColorClassName="accent-icon"
        type="monochrome"
      />
    </Pressable>
  );

  // A single remaining action does not need a menu, and no actions at all
  // means the provider cannot take anything this composer can produce.
  if (props.disabled || actions.length <= 1) {
    return actions.length === 0 ? null : button;
  }

  return (
    <ControlPillMenu
      accessible
      accessibilityLabel="Add attachment"
      accessibilityRole="button"
      actions={actions}
      onPressAction={({ nativeEvent }) => runAction(nativeEvent.event)()}
    >
      {button}
    </ControlPillMenu>
  );
}
