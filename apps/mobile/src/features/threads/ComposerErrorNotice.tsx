import { View } from "react-native";
import { Notice } from "../../components/ui/Notice";

export function ComposerErrorNotice(props: {
  readonly message: string;
  readonly stage?: string | null;
  readonly reason?: string | null;
  readonly recovery?: string | null;
  readonly onDismiss: () => void;
}) {
  const message = [
    props.message,
    ...(props.stage === undefined ? [] : [`Failure stage: ${props.stage ?? "unknown"}.`]),
    ...(props.reason ? [`Reason: ${props.reason}.`] : []),
    ...(props.recovery ? [props.recovery] : []),
  ].join("\n");
  return (
    <View className="px-4 pb-3">
      <Notice
        message={message}
        icon="exclamationmark.circle"
        iconTone="danger"
        floating
        onDismiss={props.onDismiss}
        dismissLabel="Dismiss error"
      />
    </View>
  );
}
