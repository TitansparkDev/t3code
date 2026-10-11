import { Modal, Pressable, ScrollView, View } from "react-native";

import type { HandoffTargetOption } from "@t3tools/shared/handoffTargets";

import { AndroidScreenHeader } from "../../components/AndroidScreenHeader";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { cn } from "../../lib/cn";

function quotaStatusLabel(option: HandoffTargetOption): string {
  if (option.remainingPercent !== undefined) return `${option.remainingPercent}% remaining`;
  switch (option.quotaStatus) {
    case "stale":
      return "Stale quota";
    case "not-exposed":
      return "Quota not exposed";
    case "no-data":
      return "No quota data yet";
  }
  return "Quota unavailable";
}

export function HandoffTargetPicker(props: {
  readonly visible: boolean;
  readonly options: ReadonlyArray<HandoffTargetOption>;
  readonly sourceTitle: string | undefined;
  readonly onClose: () => void;
  readonly onSelect: (option: HandoffTargetOption) => void;
}) {
  return (
    <Modal
      animationType="slide"
      onRequestClose={props.onClose}
      presentationStyle="pageSheet"
      visible={props.visible}
    >
      <View className="flex-1 bg-screen">
        <AndroidScreenHeader
          onBack={props.onClose}
          subtitle={
            props.sourceTitle
              ? `New thread from “${props.sourceTitle}”`
              : "Choose a quota pool for the new thread"
          }
          title="Choose handoff target"
        />
        <ScrollView contentContainerClassName="gap-2 px-4 py-4" keyboardShouldPersistTaps="handled">
          <Text className="px-1 pb-1 text-sm leading-5 text-foreground-muted">
            Choose by remaining quota. The handoff is prepared as an unsent draft; no provider turn
            starts until you send it.
          </Text>
          {props.options.length === 0 ? (
            <View className="rounded-2xl border border-border-subtle bg-card p-4">
              <Text className="text-sm leading-5 text-foreground-muted">
                No available provider accounts were reported by this server.
              </Text>
            </View>
          ) : (
            props.options.map((option) => (
              <Pressable
                key={option.key}
                accessibilityLabel={`${option.groupLabel}, ${quotaStatusLabel(option)}, ${option.modelName}`}
                accessibilityRole="button"
                className="min-h-16 flex-row items-center gap-3 rounded-2xl border border-border-subtle bg-card px-4 py-3 active:bg-subtle"
                onPress={() => props.onSelect(option)}
              >
                <View className="size-8 items-center justify-center rounded-full bg-subtle">
                  <SymbolView
                    name="arrow.triangle.branch"
                    size={16}
                    tintColorClassName="accent-icon"
                    type="monochrome"
                  />
                </View>
                <View className="min-w-0 flex-1 gap-0.5">
                  <Text className="text-base font-t3-medium text-foreground" numberOfLines={1}>
                    {option.groupLabel}
                  </Text>
                  <Text className="text-sm text-foreground-muted" numberOfLines={1}>
                    {option.accountLabel} · {option.modelName}
                  </Text>
                </View>
                <Text
                  className={cn(
                    "text-sm font-t3-medium tabular-nums",
                    option.quotaStatus === "fresh"
                      ? "text-success"
                      : option.quotaStatus === "stale"
                        ? "text-warning"
                        : "text-foreground-muted",
                  )}
                >
                  {quotaStatusLabel(option)}
                </Text>
              </Pressable>
            ))
          )}
        </ScrollView>
      </View>
    </Modal>
  );
}
